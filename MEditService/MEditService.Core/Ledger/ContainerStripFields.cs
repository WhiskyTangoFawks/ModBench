using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

/// <summary>
/// Strips a container record's child-major fields in place before it is ever serialized to the
/// ledger (ADR-0040/#387 amendment): a Cell/Worldspace/Quest/DialogTopic serialized whole spills its
/// children into sibling folders keyed by field name only, which two containers sharing a directory
/// silently cross-contaminate on read. Children are their own ledger entries; the parent's own file
/// carries only the parent's fields.
///
/// <b>Hand-maintained table, not generic reflection — investigated and rejected, not overlooked
/// (#370 Q5 probe).</b> The plausible generic rule — "a property is child-major if its type is (or
/// is a collection of) something implementing <see cref="IMajorRecordGetter"/>" — correctly finds
/// Cell's four fields (Persistent/Temporary/NavigationMeshes are
/// <c>ExtendedList&lt;IPlaced&gt;</c>/<c>ExtendedList&lt;NavigationMesh&gt;</c>, Landscape is a bare
/// <c>Landscape</c> — all major-record-shaped) and Quest's/DialogTopic's fields the same way. It
/// does <b>not</b> find <c>Worldspace.SubCells</c>: reflection confirms its type is
/// <c>ExtendedList&lt;WorldspaceBlock&gt;</c>, and <c>WorldspaceBlock</c> is an intermediate
/// grouping container with no FormKey of its own — it does not implement
/// <see cref="IMajorRecordGetter"/>, so the generic rule silently misses it without a second level
/// of recursion through non-major container types the rule has no principled way to bound (walk one
/// level further for everything, or only for known container shapes — which is the hand list again).
/// Given a real gap rather than a hypothetical one, and that ADR-0040 already hands this ticket the
/// definitive per-type list, the hand-maintained table is what ships — documented here as a decision,
/// not a placeholder.
/// </summary>
internal static class ContainerStripFields
{
    private static readonly Dictionary<string, string[]> ByTypeName = new(StringComparer.Ordinal)
    {
        ["Cell"] = ["Persistent", "Temporary", "NavigationMeshes", "Landscape"],
        ["Worldspace"] = ["TopCell", "SubCells"],
        ["Quest"] = ["DialogBranches", "DialogTopics"],
        ["DialogTopic"] = ["Responses"],
    };

    /// <summary>
    /// Clears (list fields) or nulls (single reference fields, e.g. <c>Landscape</c>/<c>TopCell</c>)
    /// <paramref name="record"/>'s child-major fields in place, if its type is one of the known
    /// container shapes; a no-op for every other type. In place, not a copy: called once, on a
    /// freshly deep-parsed record that is about to be serialized for the first time and then
    /// discarded (the deep-parsed mod it came from is disposed right after) — nothing else reads the
    /// pre-strip state, so there is nothing a copy would protect. A record re-read from its own
    /// ledger text is already shallow (the ledger never held the children to begin with), so this is
    /// never called on that path.
    /// </summary>
    internal static void StripInPlace(IMajorRecord record)
    {
        if (!ByTypeName.TryGetValue(record.GetType().Name, out var fields)) return;

        foreach (var fieldName in fields)
        {
            var property = record.GetType().GetProperty(fieldName)
                ?? throw new InvalidOperationException(
                    $"{record.GetType().Name} has no property '{fieldName}' to strip — ContainerStripFields' table is stale.");

            var current = property.GetValue(record);
            var clear = current?.GetType().GetMethod("Clear", Type.EmptyTypes);
            if (clear != null)
                clear.Invoke(current, null);
            else
                property.SetValue(record, null);
        }
    }
}
