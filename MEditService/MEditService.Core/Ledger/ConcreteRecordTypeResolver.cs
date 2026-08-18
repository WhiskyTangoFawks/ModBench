namespace MEditService.Core.Ledger;

/// <summary>
/// Mutagen's own stable naming convention (<c>I&lt;Type&gt;Getter</c> &lt;-&gt; <c>&lt;Type&gt;</c>)
/// recovers a concrete record type from its getter interface — the same convention
/// <see cref="Serialization.RecordTextCodec"/>'s own dispatch relies on, and the same lookup
/// <c>EditOrchestrator.VendorOnFirstTouch</c> already needed for <see cref="RecordVendor"/>'s deep-parse
/// branch. #373 adds a second caller (<see cref="LedgerGroupCommitter"/>'s renumber write, which has to
/// deserialize a record back out of its own ledger text before duplicating it under a new FormKey) —
/// promoted out of <c>EditOrchestrator</c> into its own shared home rather than copied a second time.
/// </summary>
internal static class ConcreteRecordTypeResolver
{
    private const string Prefix = "I";
    private const string Suffix = "Getter";

    internal static Type? Resolve(Type getterType)
    {
        var name = getterType.Name;
        if (name.Length <= Prefix.Length + Suffix.Length || !name.StartsWith(Prefix, StringComparison.Ordinal)
            || !name.EndsWith(Suffix, StringComparison.Ordinal))
        {
            return null;
        }

        var concreteName = name[Prefix.Length..^Suffix.Length];
        return Type.GetType($"Mutagen.Bethesda.Fallout4.{concreteName}, Mutagen.Bethesda.Fallout4");
    }
}
