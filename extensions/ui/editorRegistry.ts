type RenderableEditor = {
  requestRender(): void;
};

export const editors = new Set<RenderableEditor>();

export function notifyEditors(): void {
  for (const editor of editors) editor.requestRender();
}
