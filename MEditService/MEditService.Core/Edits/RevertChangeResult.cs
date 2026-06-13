namespace MEditService.Core.Edits;

public abstract record RevertChangeResult
{
    public sealed record Reverted : RevertChangeResult;
    public sealed record NotFound : RevertChangeResult;
    public sealed record GroupOwned(Guid GroupId) : RevertChangeResult;
}
