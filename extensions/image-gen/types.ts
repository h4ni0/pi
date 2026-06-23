export type ImageGenDetails = {
  action: "generate" | "edit";
  model: string;
  path: string;
  revisedPrompt?: string;
};

export type ImageApiResponse = {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
};

export type HostedImageResult = {
  result: string;
  revisedPrompt?: string;
};

export type ImageContentLike = { type: "image"; data: string; mimeType: string };

export type TextContentLike = { type: "text"; text: string };
