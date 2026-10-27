// The one short line every bill and receipt prints with the business's
// privacy contact (Settings › Personal data): "Your personal data: <contact>".
// Empty while no privacy notice is published. `biz` is the open business
// (its context carries the line); the restaurant's comes with its settings.
export const privacyLine = (biz) => biz?.context?.privacy?.line || "";
