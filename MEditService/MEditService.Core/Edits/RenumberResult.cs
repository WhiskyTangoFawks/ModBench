using MEditService.Core.Queries;

namespace MEditService.Core.Edits;

public abstract record RenumberResult
{
    public sealed record NoSession : RenumberResult;
    public sealed record PluginImmutable(string Plugin) : RenumberResult;
    public sealed record RecordNotFound : RenumberResult;
    public sealed record ImmutableReferences(IReadOnlyList<ReferenceResult> Blockers) : RenumberResult;
    public sealed record FormIdInUse : RenumberResult;
    public sealed record Staged(ChangeGroup Group) : RenumberResult;
}
