namespace MEditService.Core.Edits;

public abstract record StageEditResult
{
    public sealed record Staged(IReadOnlyList<PendingChange> Changes) : StageEditResult;
    public sealed record RecordNotFound() : StageEditResult;
    public sealed record PluginImmutable(string Plugin) : StageEditResult;
    public sealed record ReadOnlyFields(IReadOnlyList<string> Fields) : StageEditResult;
    public sealed record NoSession() : StageEditResult;
    public sealed record BlockedByGroup(Guid GroupId) : StageEditResult;
}
