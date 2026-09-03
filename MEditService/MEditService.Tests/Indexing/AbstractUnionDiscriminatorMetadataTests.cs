using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>
/// The discriminator an abstract union exposes (<c>concrete_type</c>) is an editable choice among
/// the union's leaves, so its metadata has to carry everything the editor needs to *present* that
/// choice: a closed value set (an enum, not free text) and a label for the row and for every value.
///
/// <para>The user is never shown a Mutagen class name (#686's own ruling), so the labels are the
/// wire contract, not something the webview derives — a frontend humanizer would be exactly the
/// value inference PRD corollary 5 forbids, and it has no way to know the union's base type. The
/// labels here are a pure function of the schema: strip the base type's own words off the leaf's,
/// which is generic across games and needs no per-game table.</para>
/// </summary>
public class AbstractUnionDiscriminatorMetadataTests
{
    private static FieldMetadata Discriminator(string table, params string[] path)
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        var meta = schemas[table].RecordColumns.Single(c => c.Name == path[0]).ToFieldMetadata();
        foreach (var hop in path.Skip(1))
            meta = hop == "[]"
                ? meta.ElementType!
                : meta.Fields!.Single(f => f.Name == hop);
        return meta;
    }

    [Fact]
    public void QuestAliasDiscriminator_IsAnEnumOverTheLeafClassNames()
    {
        var kind = Discriminator("qust", "aliases", "[]", "concrete_type");

        Assert.Equal("enum", kind.Type);
        Assert.Equal(
            ["QuestReferenceAlias", "QuestLocationAlias", "QuestCollectionAlias"],
            kind.EnumValues);
    }

    [Fact]
    public void QuestAliasDiscriminator_LabelsTheRowAndEveryLeafWithoutNamingAClass()
    {
        var kind = Discriminator("qust", "aliases", "[]", "concrete_type");

        Assert.Equal("Kind", kind.DisplayLabel);
        Assert.Equal(["Reference", "Location", "Collection"], kind.EnumLabels);
    }

    /// <summary>
    /// The one shape the humanizer cannot reduce: <c>NpcLevel</c> *is* its own base's name
    /// (<c>ANpcLevel</c>), so stripping the base leaves nothing. Falling back to the leaf's own
    /// words spaced out beats an empty label — the ticket's own rival, a humanizer that degenerates
    /// silently, is exactly this case answering "" or a bare class name.
    /// </summary>
    [Fact]
    public void NpcLevelDiscriminator_FallsBackToTheLeafsOwnWordsWhenStrippingTheBaseLeavesNothing()
    {
        var kind = Discriminator("npc_", "level", "concrete_type");

        Assert.Equal(["NpcLevel", "PcLevelMult"], kind.EnumValues);
        Assert.Equal(["Npc Level", "Pc Level Mult"], kind.EnumLabels);
    }

    /// <summary>
    /// Every abstract union in the game, not the two demoed: a label per value, none empty, none
    /// colliding with a sibling (two leaves reducing to one label would make the dropdown
    /// unusable and the choice ambiguous).
    /// </summary>
    [Fact]
    public void EveryDiscriminatorInTheGame_CarriesOneDistinctNonEmptyLabelPerLeaf()
    {
        var offenders = new List<string>();
        foreach (var (table, path, meta) in AllFields())
        {
            if (meta.Name != "concrete_type") continue;
            var labels = meta.EnumLabels;
            if (labels == null || labels.Count != meta.EnumValues.Count
                || labels.Any(string.IsNullOrWhiteSpace)
                || labels.Distinct(StringComparer.Ordinal).Count() != labels.Count
                || meta.DisplayLabel != "Kind")
            {
                offenders.Add($"{table}.{path}: [{string.Join(", ", labels ?? [])}]");
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryDiscriminatorInTheGame_IsAnEnum()
    {
        var offenders = AllFields()
            .Where(f => f.Meta.Name == "concrete_type" && f.Meta.Type != "enum")
            .Select(f => $"{f.Table}.{f.Path}: {f.Meta.Type}")
            .ToList();

        Assert.Empty(offenders);
    }

    private static IEnumerable<(string Table, string Path, FieldMetadata Meta)> AllFields()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        foreach (var (table, schema) in schemas)
            foreach (var column in schema.RecordColumns)
                foreach (var found in Walk(table, column.Name, column.ToFieldMetadata(), 0))
                    yield return found;
    }

    private static IEnumerable<(string Table, string Path, FieldMetadata Meta)> Walk(
        string table, string path, FieldMetadata meta, int depth)
    {
        yield return (table, path, meta);
        // The reflected schema's own nesting is bounded (BuildSubSchema stops at depth 3, and an
        // array element adds one hop per level); this only stops a walk if that ever changes.
        if (depth > 12) yield break;
        if (meta.ElementType != null)
            foreach (var f in Walk(table, path + "[]", meta.ElementType, depth + 1)) yield return f;
        foreach (var sub in meta.Fields ?? [])
            foreach (var f in Walk(table, path + "." + sub.Name, sub, depth + 1)) yield return f;
    }
}
