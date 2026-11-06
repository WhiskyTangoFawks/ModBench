namespace MEditService.RecordIndex.Store;

internal sealed class OwedSweep(IReadOnlySet<string>? formKeys)
{
    internal static OwedSweep None { get; } = new(new HashSet<string>());

    internal static OwedSweep Every { get; } = new(null);

    /// <summary>Null is every FormKey.</summary>
    internal IReadOnlySet<string>? FormKeys { get; } = formKeys;

    internal bool IsOwed => FormKeys is null || FormKeys.Count > 0;

    internal OwedSweep Union(OwedSweep other) =>
        FormKeys is null || other.FormKeys is null
            ? Every
            : new OwedSweep(new HashSet<string>(FormKeys.Concat(other.FormKeys), StringComparer.OrdinalIgnoreCase));
}
