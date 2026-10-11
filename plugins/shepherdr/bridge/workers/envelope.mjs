/** A delivered task or message as the worker's model reads it, whatever the route. */
export function envelopeText(message) {
	return [
		message.sender,
		message.context && `<herdr_guidance>${message.context}</herdr_guidance>`,
		message.text,
	]
		.filter(Boolean)
		.join("\n\n");
}
