namespace MEditService.RecordIndex.Store;

internal sealed class OwedSweep(IReadOnlySet<string> formKeys)
{
    internal static OwedSweep None { get; } = new(new HashSet<string>());

    internal IReadOnlySet<string> FormKeys { get; } = formKeys;

    internal bool IsOwed => FormKeys.Count > 0;

    internal OwedSweep Union(OwedSweep other) =>
        new(new HashSet<string>(FormKeys.Concat(other.FormKeys), StringComparer.OrdinalIgnoreCase));
}
