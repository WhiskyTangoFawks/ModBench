/** What a rename that carries every reference came to (ADR-0028). `unapplied`: the edit failed, and may have partly
 *  landed. `failed`: a commit failed after the edit, which changed files when `edited` and moved each of `moved`. */
export type ChangeResult =
  | { readonly applied: true; readonly cannotFollow: readonly string[] }
  | { readonly applied: false; readonly refusal: string }
  | { readonly applied: false; readonly unapplied: string }
  | { readonly applied: false; readonly failed: string; readonly edited: boolean; readonly moved: readonly { readonly from: string; readonly to: string }[] };
