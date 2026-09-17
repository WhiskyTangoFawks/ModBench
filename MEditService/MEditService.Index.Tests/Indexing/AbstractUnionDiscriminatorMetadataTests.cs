using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

/// <summary>The user is never shown a Mutagen class name, so labels are the wire contract: a
/// frontend humanizer cannot know the union's base type.</summary>
public class AbstractUnionDiscriminatorMetadataTests
{
    private static FieldMetadata Discriminator(string table, params string[] path)
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        var meta = schemas[table].RecordColumns.Single(c => c.Name == path[0]).ToFieldMetadata();
        foreach (var hop in path.Skip(1))
            meta = hop == "[]"
                ? meta.ElementType
                    ?? throw new InvalidOperationException($"Expected '{table}' step '{hop}' to have an element type.")
                : (meta.Fields ?? throw new InvalidOperationException($"Expected '{table}' step '{hop}' to have fields."))
                    .Single(f => f.Name == hop);
        return meta;
    }

    [Fact]
    public void QuestAliasDiscriminator_IsAnEnumOverTheLeafClassNames()
    {
        var kind = Discriminator("qust", "Aliases", "[]", "MutagenObjectType");

        Assert.Equal("enum", kind.Type);
        Assert.Equal(
            ["QuestReferenceAlias", "QuestLocationAlias", "QuestCollectionAlias"],
            kind.EnumMembers.Select(m => m.Value));
    }

    [Fact]
    public void QuestAliasDiscriminator_LabelsTheRowAndEveryLeafWithoutNamingAClass()
    {
        var kind = Discriminator("qust", "Aliases", "[]", "MutagenObjectType");

        Assert.Equal("Kind", kind.DisplayLabel);
        Assert.Equal(["Reference", "Location", "Collection"], kind.EnumMembers.Select(m => m.Label));
    }

    [Fact]
    public void NpcLevelDiscriminator_FallsBackToTheLeafsOwnWordsWhenStrippingTheBaseLeavesNothing()
    {
        var kind = Discriminator("npc_", "Level", "MutagenObjectType");

        Assert.Equal(["NpcLevel", "PcLevelMult"], kind.EnumMembers.Select(m => m.Value));
        Assert.Equal(["Npc Level", "Pc Level Mult"], kind.EnumMembers.Select(m => m.Label));
    }

    [Fact]
    public void EveryDiscriminatorInTheGame_CarriesOneDistinctNonEmptyLabelPerLeaf()
    {
        var offenders = new List<string>();
        foreach (var (table, path, meta) in AllFields())
        {
            if (meta.Name != "MutagenObjectType") continue;
            var labels = meta.EnumMembers.Select(m => m.Label).ToList();
            if (labels.Any(string.IsNullOrWhiteSpace)
                || labels.Distinct(StringComparer.Ordinal).Count() != labels.Count
                || meta.DisplayLabel != "Kind")
            {
                offenders.Add($"{table}.{path}: [{string.Join(", ", labels)}]");
            }
        }

        Assert.Empty(offenders);
    }

    [Fact]
    public void EveryDiscriminatorInTheGame_IsAnEnum()
    {
        var offenders = AllFields()
            .Where(f => f.Meta.Name == "MutagenObjectType" && f.Meta.Type != "enum")
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
