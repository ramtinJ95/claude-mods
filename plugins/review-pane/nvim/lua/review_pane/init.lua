-- The Neovim side of review-pane's /review-diff. Claude Code starts this Neovim with
-- `start(dir)`: `dir` holds review.json (what to review), events.jsonl (what this side
-- tells the mod, one JSON object per line) and annotations.json (the notes so far, so a
-- closed Neovim reopens with them). The mod answers by calling `answer` and `finished`
-- over this instance's --listen socket.
local M = {}

local KINDS = {
  comment = { label = 'Comment', sign = '•', hl = 'DiagnosticInfo' },
  suggestion = { label = 'Suggestion', sign = '+', hl = 'DiagnosticOk' },
  issue = { label = 'Issue', sign = '!', hl = 'DiagnosticError' },
  question = { label = 'Question', sign = '?', hl = 'DiagnosticWarn' },
}
local SUBCOMMANDS = { 'comment', 'suggest', 'issue', 'ask', 'overall', 'edit', 'delete', 'show', 'next', 'prev', 'list', 'files', 'finish', 'discard' }
-- Lines of the file around a question, sent with it as context.
local CONTEXT = 10
-- Lines of an answer drawn under the code; `:Review show` reads the rest.
local ANSWER_LINES = 6

local ns = vim.api.nvim_create_namespace('review_pane')
local WARN, ERROR = vim.log.levels.WARN, vim.log.levels.ERROR

--- The open review: { dir, root, title, notes = { [id] = note }, overall?, next_id }.
--- A note is { id, kind, file, start, end, body, reply?, buf?, mark?, view? }: `start`/`end`
--- are 1-based lines, current only while the note has no `mark` in a loaded `buf`.
local S

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = 'Review' })
end

local function read_json(path)
  local file = io.open(path, 'r')
  if not file then return nil end
  local text = file:read('*a')
  file:close()
  return vim.json.decode(text)
end

local function write_json(path, value)
  local file = assert(io.open(path, 'w'))
  file:write(vim.json.encode(value))
  file:close()
end

--- Tells the mod about `event`; false, after saying so, when it cannot.
local function send(event)
  local file, err = io.open(S.dir .. '/events.jsonl', 'a')
  if not file then
    notify('Could not reach Claude Code: ' .. err, ERROR)
    return false
  end
  file:write(vim.json.encode(event) .. '\n')
  file:close()
  return true
end

local function real(path)
  return vim.uv.fs_realpath(path) or vim.fs.normalize(path)
end

--- The buffer's file relative to the repository root, or nil for anything else.
local function relative(buf)
  if vim.bo[buf].buftype ~= '' then return nil end
  local name = vim.api.nvim_buf_get_name(buf)
  if name == '' then return nil end
  local prefix = S.root .. '/'
  local path = real(name)
  if path:sub(1, #prefix) ~= prefix then return nil end
  return path:sub(#prefix + 1)
end

local function where(file, first, last)
  return first == last and ('%s line %d'):format(file, first) or ('%s lines %d-%d'):format(file, first, last)
end

--- The note's lines as they stand now.
local function range(note)
  if note.mark and note.buf and vim.api.nvim_buf_is_loaded(note.buf) then
    local pos = vim.api.nvim_buf_get_extmark_by_id(note.buf, ns, note.mark, { details = true })
    if pos[1] then return pos[1] + 1, math.max(pos[1], pos[3].end_row or pos[1]) + 1 end
  end
  return note.start, note['end']
end

local function wrap(text, width)
  local lines = {}
  for _, paragraph in ipairs(vim.split(text, '\n', { plain = true })) do
    local line = ''
    for word in paragraph:gmatch('%S+') do
      if line ~= '' and vim.fn.strdisplaywidth(line .. ' ' .. word) > width then
        table.insert(lines, line)
        line = word
      else
        line = line == '' and word or line .. ' ' .. word
      end
    end
    table.insert(lines, line)
  end
  return lines
end

--- The virtual lines drawn under a note's last line: its label and body, then any answer.
local function display(note)
  local kind = KINDS[note.kind]
  local width = math.max(30, vim.o.columns - 16)
  local lines = {}
  local function push(text, hl, first)
    for index, line in ipairs(wrap(text, width)) do
      table.insert(lines, { { (index == 1 and first or '  '), kind.hl }, { line, hl } })
    end
  end
  push(note.body, kind.hl, kind.sign .. ' ' .. kind.label .. ': ')
  local reply = note.reply
  if reply and reply.state == 'pending' then
    push('Asking Claude…', 'Comment', '  ')
  elseif reply and reply.state == 'failed' then
    push(reply.error, 'DiagnosticError', '  ')
  elseif reply and reply.state == 'answered' then
    local answer = wrap(reply.text, width)
    for index = 1, math.min(#answer, ANSWER_LINES) do
      table.insert(lines, { { '  │ ', 'Comment' }, { answer[index], 'Comment' } })
    end
    if #answer > ANSWER_LINES then
      table.insert(lines, { { ('  │ … %d more lines: :Review show'):format(#answer - ANSWER_LINES), 'Comment' } })
    end
  end
  return lines
end

--- Draws the note where its buffer is loaded: a sign on its first line, its text under its last.
local function render(note)
  if not (note.buf and vim.api.nvim_buf_is_loaded(note.buf)) then return end
  local first, last = range(note)
  local count = vim.api.nvim_buf_line_count(note.buf)
  first, last = math.min(first, count), math.min(last, count)
  local kind = KINDS[note.kind]
  note.mark = vim.api.nvim_buf_set_extmark(note.buf, ns, first - 1, 0, {
    id = note.mark,
    end_row = last - 1,
    -- Both ends at column 0 move together, so a line inserted above the note cannot leave its end behind its start.
    end_right_gravity = true,
    sign_text = kind.sign,
    sign_hl_group = kind.hl,
  })
  note.view = vim.api.nvim_buf_set_extmark(note.buf, ns, last - 1, 0, { id = note.view, virt_lines = display(note) })
end

local function unrender(note)
  if note.buf and vim.api.nvim_buf_is_valid(note.buf) then
    if note.mark then vim.api.nvim_buf_del_extmark(note.buf, ns, note.mark) end
    if note.view then vim.api.nvim_buf_del_extmark(note.buf, ns, note.view) end
  end
  note.mark, note.view = nil, nil
end

--- Notes in file order, then by line.
local function sorted()
  local notes = {}
  for _, note in pairs(S.notes) do
    note.start, note['end'] = range(note)
    table.insert(notes, note)
  end
  table.sort(notes, function(a, b)
    if a.file ~= b.file then return a.file < b.file end
    if a.start ~= b.start then return a.start < b.start end
    return a.id < b.id
  end)
  return notes
end

local function save()
  local notes = {}
  for _, note in ipairs(sorted()) do
    table.insert(notes, { id = note.id, kind = note.kind, file = note.file, start = note.start, ['end'] = note['end'], body = note.body, reply = note.reply })
  end
  write_json(S.dir .. '/annotations.json', { overall = S.overall, next_id = S.next_id, notes = notes })
end

local function lines(note, first, last)
  return vim.api.nvim_buf_get_lines(note.buf, first - 1, last, false)
end

local function ask(note)
  local first, last = range(note)
  local from, to = math.max(1, first - CONTEXT), math.min(vim.api.nvim_buf_line_count(note.buf), last + CONTEXT)
  note.reply = { state = 'pending', token = tostring(vim.uv.hrtime()) }
  local sent = send({
    type = 'ask',
    id = note.id,
    token = note.reply.token,
    file = note.file,
    start = first,
    ['end'] = last,
    lines = lines(note, first, last),
    context = { start = from, lines = lines(note, from, to) },
    body = note.body,
  })
  if not sent then note.reply = { state = 'failed', error = 'Not asked: Claude Code could not be reached.' } end
  render(note)
  save()
end

--- The note under the cursor: the one whose range starts last at or above it.
local function current()
  local buf = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local found
  for _, note in pairs(S.notes) do
    if note.buf == buf then
      local first, last = range(note)
      if first <= line and line <= last and (not found or first >= range(found)) then found = note end
    end
  end
  return found
end

local function annotate(kind, first, last)
  local buf = vim.api.nvim_get_current_buf()
  local file = relative(buf)
  if not file then return notify('Annotate a file of the repository under review (' .. S.root .. ').', WARN) end
  vim.ui.input({ prompt = ('%s on %s: '):format(KINDS[kind].label, where(file, first, last)) }, function(body)
    if not body or vim.trim(body) == '' then return end
    local note = { id = S.next_id, kind = kind, file = file, buf = buf, start = first, ['end'] = last, body = body }
    S.next_id = S.next_id + 1
    S.notes[note.id] = note
    render(note)
    save()
    if kind == 'question' then ask(note) end
  end)
end

local function overall()
  vim.ui.input({ prompt = 'Comment on the changes as a whole (empty removes it): ', default = S.overall or '' }, function(body)
    if body == nil then return end
    S.overall = vim.trim(body) ~= '' and body or nil
    save()
  end)
end

local function edit()
  local note = current()
  if not note then return notify('No annotation under the cursor.', WARN) end
  vim.ui.input({ prompt = KINDS[note.kind].label .. ': ', default = note.body }, function(body)
    if not body or vim.trim(body) == '' or body == note.body then return end
    -- An edit drops the answer to the previous text.
    note.body, note.reply = body, nil
    render(note)
    save()
    if note.kind == 'question' then ask(note) end
  end)
end

local function delete()
  local note = current()
  if not note then return notify('No annotation under the cursor.', WARN) end
  unrender(note)
  S.notes[note.id] = nil
  save()
end

local function show()
  local note = current()
  if not note then return notify('No annotation under the cursor.', WARN) end
  local first, last = range(note)
  local text = { ('# %s · %s'):format(KINDS[note.kind].label, where(note.file, first, last)), '' }
  vim.list_extend(text, vim.split(note.body, '\n', { plain = true }))
  local reply = note.reply
  if reply then
    table.insert(text, '')
    if reply.state == 'answered' then
      table.insert(text, '## Answer')
      table.insert(text, '')
      vim.list_extend(text, vim.split(reply.text, '\n', { plain = true }))
    else
      table.insert(text, reply.state == 'pending' and '_Asking Claude…_' or reply.error)
    end
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, text)
  vim.bo[buf].filetype = 'markdown'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].modifiable = false
  local width = math.min(100, vim.o.columns - 8)
  local height = math.min(#text + 2, vim.o.lines - 6)
  vim.api.nvim_open_win(buf, true, {
    relative = 'editor',
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    border = 'rounded',
    title = ' Review ',
  })
  vim.wo.wrap = true
  vim.wo.linebreak = true
  vim.keymap.set('n', 'q', '<cmd>close<cr>', { buffer = buf })
end

--- Loads the note's file if no buffer holds it, so its lines can be read; BufReadPost draws it.
local function load(note)
  if note.buf and vim.api.nvim_buf_is_loaded(note.buf) then return end
  local buf = vim.fn.bufadd(S.root .. '/' .. note.file)
  vim.fn.bufload(buf)
  if not note.buf then
    note.buf = buf
    render(note)
  end
end

local function jump(note)
  vim.cmd.edit(vim.fn.fnameescape(S.root .. '/' .. note.file))
  vim.api.nvim_win_set_cursor(0, { note.start, 0 })
end

--- Moves to the next (`delta` 1) or previous (-1) note in file order, wrapping around.
local function step(delta)
  local notes = sorted()
  if #notes == 0 then return notify('No annotations yet.', WARN) end
  local file = relative(vim.api.nvim_get_current_buf()) or ''
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local function after(note) return note.file > file or (note.file == file and note.start > line) end
  local function before(note) return note.file < file or (note.file == file and note.start < line) end
  if delta > 0 then
    for _, note in ipairs(notes) do
      if after(note) then return jump(note) end
    end
    return jump(notes[1])
  end
  for index = #notes, 1, -1 do
    if before(notes[index]) then return jump(notes[index]) end
  end
  jump(notes[#notes])
end

local function list()
  local items = {}
  if S.overall then table.insert(items, { text = '[Overall] ' .. S.overall, valid = 0 }) end
  for _, note in ipairs(sorted()) do
    table.insert(items, { filename = S.root .. '/' .. note.file, lnum = note.start, text = ('[%s] %s'):format(KINDS[note.kind].label, note.body) })
  end
  if #items == 0 then return notify('No annotations yet.', WARN) end
  vim.fn.setloclist(0, {}, ' ', { title = 'Review annotations', items = items })
  vim.cmd.lopen()
end

local function files()
  local items = {}
  for _, stop in ipairs(S.stops) do
    local path = S.root .. '/' .. stop.file
    if vim.fn.filereadable(path) == 1 then
      table.insert(items, { filename = path, lnum = stop.line, text = stop.text })
    else
      table.insert(items, { text = stop.file .. ' (deleted)', valid = 0 })
    end
  end
  vim.fn.setqflist({}, ' ', { title = 'Review: ' .. S.title, items = items })
  vim.cmd('botright copen')
end

local function clear()
  for _, note in pairs(S.notes) do unrender(note) end
  S.notes, S.overall = {}, nil
  os.remove(S.dir .. '/annotations.json')
end

local function finish()
  local items = {}
  if S.overall then table.insert(items, { kind = 'comment', body = S.overall }) end
  for _, note in pairs(S.notes) do
    if note.kind ~= 'question' then load(note) end
  end
  for _, note in ipairs(sorted()) do
    if note.kind ~= 'question' then
      table.insert(items, {
        kind = note.kind,
        file = note.file,
        start = note.start,
        ['end'] = note['end'],
        lines = lines(note, note.start, note['end']),
        body = note.body,
      })
    end
  end
  if #items == 0 then return notify('Nothing to send: add a comment, suggestion or issue (questions stay here).', WARN) end
  if send({ type = 'finish', annotations = items }) then notify('Sending the review to Claude Code…') end
end

local function discard()
  local count = vim.tbl_count(S.notes) + (S.overall and 1 or 0)
  if count > 0 and vim.fn.confirm(('Discard %d annotations and close?'):format(count), '&Yes\n&No', 2) ~= 1 then return end
  clear()
  vim.cmd('confirm qall')
end

local ACTIONS = {
  comment = function(first, last) annotate('comment', first, last) end,
  suggest = function(first, last) annotate('suggestion', first, last) end,
  issue = function(first, last) annotate('issue', first, last) end,
  ask = function(first, last) annotate('question', first, last) end,
  overall = overall,
  edit = edit,
  delete = delete,
  show = show,
  next = function() step(1) end,
  prev = function() step(-1) end,
  list = list,
  files = files,
  finish = finish,
  discard = discard,
}

local KEYS = {
  { 'c', 'comment', 'comment', true },
  { 's', 'suggest', 'suggestion', true },
  { 'i', 'issue', 'issue', true },
  { 'a', 'ask', 'ask a question', true },
  { 'o', 'overall', 'overall comment' },
  { 'e', 'edit', 'edit annotation' },
  { 'x', 'delete', 'delete annotation' },
  { 'v', 'show', 'read annotation' },
  { 'l', 'list', 'list annotations' },
  { 'f', 'files', 'changed files' },
  { 'y', 'finish', 'finish: send to Claude Code' },
  { 'q', 'discard', 'discard and close' },
}

--- Binds a key only where the person's config has not: their mappings win.
local function map(mode, lhs, rhs, desc)
  if vim.fn.maparg(lhs, mode) == '' then vim.keymap.set(mode, lhs, rhs, { desc = 'Review: ' .. desc }) end
end

local function setup()
  vim.api.nvim_create_user_command('Review', function(opts)
    local action = ACTIONS[opts.fargs[1]]
    if not action then return notify('Unknown :Review command. Try one of: ' .. table.concat(SUBCOMMANDS, ', '), WARN) end
    action(opts.line1, opts.line2)
  end, {
    nargs = 1,
    range = true,
    complete = function(lead)
      return vim.tbl_filter(function(name) return name:sub(1, #lead) == lead end, SUBCOMMANDS)
    end,
  })
  for _, key in ipairs(KEYS) do
    map('n', '<leader>r' .. key[1], '<cmd>Review ' .. key[2] .. '<cr>', key[3])
    if key[4] then map('x', '<leader>r' .. key[1], ':Review ' .. key[2] .. '<cr>', key[3]) end
  end
  map('n', ']r', '<cmd>Review next<cr>', 'next annotation')
  map('n', '[r', '<cmd>Review prev<cr>', 'previous annotation')
  pcall(function() require('which-key').add({ { '<leader>r', group = 'review' } }) end)

  local group = vim.api.nvim_create_augroup('review_pane', { clear = true })
  -- A note keeps its lines while its buffer is unloaded, and is drawn again when it loads.
  vim.api.nvim_create_autocmd('BufUnload', {
    group = group,
    callback = function(args)
      for _, note in pairs(S.notes) do
        if note.buf == args.buf then
          note.start, note['end'] = range(note)
          note.buf, note.mark, note.view = nil, nil, nil
        end
      end
    end,
  })
  vim.api.nvim_create_autocmd('BufReadPost', {
    group = group,
    callback = function(args)
      local file = relative(args.buf)
      for _, note in pairs(S.notes) do
        if not note.buf and note.file == file then
          note.buf = args.buf
          render(note)
        end
      end
    end,
  })
  vim.api.nvim_create_autocmd('VimLeavePre', {
    group = group,
    callback = function()
      save()
      send({ type = 'closed', count = vim.tbl_count(S.notes) + (S.overall and 1 or 0) })
    end,
  })
end

local function restore()
  local saved = read_json(S.dir .. '/annotations.json')
  if not saved then return 0 end
  S.overall, S.next_id = saved.overall, saved.next_id or 1
  for _, note in ipairs(saved.notes or {}) do
    -- An answer still on its way died with the Neovim that asked.
    if note.reply and note.reply.state == 'pending' then note.reply = { state = 'failed', error = 'No answer: Neovim closed before it came.' } end
    S.notes[note.id] = note
    load(note)
  end
  return #(saved.notes or {}) + (S.overall and 1 or 0)
end

function M.start(dir)
  if vim.fn.has('nvim-0.10') == 0 then return notify('review-pane needs Neovim 0.10 or newer.', ERROR) end
  local review = read_json(dir .. '/review.json')
  if not review then return notify('No review in ' .. dir .. '.', ERROR) end
  S = { dir = dir, root = review.root, title = review.title, stops = review.stops, notes = {}, next_id = 1 }
  setup()
  local restored = restore()
  local ok, gitsigns = pcall(require, 'gitsigns')
  if ok and review.base then gitsigns.change_base(review.base, true) end
  files()
  vim.cmd('wincmd p')
  if #S.stops > 0 then pcall(vim.cmd.cfirst) end
  local resumed = restored > 0 and (', %d annotations restored'):format(restored) or ''
  notify(('Reviewing the %s%s. <leader>r and :Review <Tab> list the commands.'):format(review.title, resumed))
end

--- The mod's answer to a question: { id, token, text } or { id, token, error }.
--- An answer to an edited or re-asked question is dropped.
function M.answer(payload)
  local reply = vim.json.decode(payload)
  local note = S and S.notes[reply.id]
  if not (note and note.reply and note.reply.state == 'pending' and note.reply.token == reply.token) then return 0 end
  note.reply = reply.text and { state = 'answered', text = reply.text } or { state = 'failed', error = reply.error }
  render(note)
  save()
  notify(('Answered: %s'):format(where(note.file, range(note))))
  return 1
end

--- How the mod took the finished review: { ok = true } once it is in the prompt, else { error }.
function M.finished(payload)
  local result = vim.json.decode(payload)
  if not result.ok then
    notify('The review was not sent: ' .. result.error, ERROR)
    return 0
  end
  clear()
  notify("The review is in Claude Code's prompt.")
  vim.schedule(function() vim.cmd('confirm qall') end)
  return 1
end

return M
