import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { create, realDeps } from "./extension.ts";

const schema = Type.Object({
	question: Type.String({ description: "The decision made, or the question for the user (one short sentence)." }),
	options: Type.Optional(Type.Array(Type.String(), { description: "Answer options, shown as numbered choices." })),
	recommended: Type.Optional(Type.String({ description: "Your recommended option / the choice you made. Required for severity normal (it is the timeout default)." })),
	severity: StringEnum(["minor", "normal", "critical"] as const),
	why: Type.Optional(Type.String({ description: "Short reasoning, plus the replyTo id if the question comes from a subagent." })),
});

export default function (pi: ExtensionAPI) {
	create(pi, realDeps(schema));
}
