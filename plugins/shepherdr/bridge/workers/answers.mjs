/**
 * The answer checks every question tool shares, for the answers shape
 * workers/index.mjs documents: one response per prompt, in order, choosing
 * only its own choices, each once, and one for a single-answer prompt.
 */
export function checkAnswers(prompts, answers) {
	if (answers.length !== prompts.length)
		throw new Error(
			`answer requires ${prompts.length} response${prompts.length === 1 ? "" : "s"}, in prompt order`,
		);
	for (const [index, prompt] of prompts.entries()) {
		const selections = answers[index].selections ?? [];
		for (const label of selections)
			if (!prompt.choices.some((choice) => choice.label === label))
				throw new Error(
					`unknown choice ${JSON.stringify(label)} for ${JSON.stringify(prompt.title)}`,
				);
		if (new Set(selections).size !== selections.length)
			throw new Error(`duplicate choice for ${JSON.stringify(prompt.title)}`);
		if (!prompt.multiple && selections.length > 1)
			throw new Error(`${JSON.stringify(prompt.title)} accepts one choice`);
	}
}
