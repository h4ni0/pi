import { Type, type Static } from "typebox";

export const imageGenParams = Type.Object({
  prompt: Type.String({
    description:
      "Detailed image generation or edit prompt. Include all visual requirements.",
  }),
  action: Type.Union([Type.Literal("generate"), Type.Literal("edit")], {
    description:
      "Use `generate` for a new image, `edit` to modify an uploaded or previously generated image.",
  }),
});

export type ImageGenParams = Static<typeof imageGenParams>;
