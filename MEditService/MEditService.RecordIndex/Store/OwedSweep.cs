namespace MEditService.RecordIndex.Store;

/// <summary>The FormKeys whose winner is owed a sweep, or every one. Null keys is every one.</summary>
internal sealed record OwedSweep(IReadOnlySet<string>? FormKeys)
{
    internal static OwedSweep None { get; } = new(new HashSet<string>());

    internal static OwedSweep Every { get; } = new((IReadOnlySet<string>?)null);

    internal bool IsOwed => FormKeys is null || FormKeys.Count > 0;

    internal OwedSweep And(OwedSweep other) =>
        FormKeys is null || other.FormKeys is null
            ? Every
            : new OwedSweep(new HashSet<string>(FormKeys.Concat(other.FormKeys), StringComparer.OrdinalIgnoreCase));
}
