namespace MEditService.Core.Edits;

/// <summary>
/// Why an edit was refused — typed, never a string a caller would have to match on (ADR-0026). The
/// UI and the HTTP API both branch on this: two of these values are the untracked signposting AC4
/// pins, and each names a different way out, so collapsing them into one "read-only" would lose the
/// only thing the message has to say.
/// </summary>
public enum RecordEditRefusal
{
    /// <summary>No refusal — the edit was applied.</summary>
    None,

    /// <summary>The plugin lives in a mod folder that has no <c>.git</c>. The way out is one
    /// command, once, for this mod: Track (ADR-0041 — the friction is deliberate).</summary>
    PluginNotTracked,

    /// <summary>The plugin has no mod folder at all — a vanilla or DLC master resolved straight from
    /// the game's Data directory, where Track does not apply. The way out is the community's own
    /// blessed path: author a patch plugin holding the override.</summary>
    PluginHasNoModFolder,

    /// <summary>The plugin holds no such record at the effective ref.</summary>
    RecordNotFound,

    /// <summary>No field of that name on this record type.</summary>
    FieldNotFound,

    /// <summary>The field exists but is not writable — masters (derived at compile, ADR-0038), a
    /// record's own FormKey, and the widened text columns.</summary>
    FieldReadOnly,

    /// <summary>The new value would create a Dangling or Type-Mismatched FormLink (CONTEXT.md).
    /// Always a data error, and blocked at edit time rather than reported afterwards.</summary>
    InvalidFormLink,
}

/// <summary>
/// One edit's outcome. <see cref="Message"/> is user-facing prose for the refusal — it names the way
/// out, since a refusal the user cannot act on is just dead UI (AC4's "no silent dead UI").
/// </summary>
public sealed record RecordEditResult(bool Applied, RecordEditRefusal Refusal, string Message)
{
    public static RecordEditResult Success() => new(true, RecordEditRefusal.None, "");

    public static RecordEditResult Refused(RecordEditRefusal refusal, string message) =>
        new(false, refusal, message);
}
