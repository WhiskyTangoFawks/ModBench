using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #710: <c>array_add</c> against every abstract-element array Fallout 4 has, not only the two
/// with an end-to-end fixture. <see cref="ArrayOpWriter"/> is called directly on an in-memory
/// record — no plugin on disk — because what is under test is whether the default element it builds
/// names a leaf the write path can actually construct, which is settled before anything is written.
/// </summary>
public class UnionArrayAddInventoryTests
{
    private static readonly ModKey Key = ModKey.FromFileName("UnionArrayAdd710.esp");

    /// <summary>The inventory itself, asserted rather than discovered at run time: a fifth
    /// discriminator-bearing array (#701 expands script properties into one) must arrive here as a
    /// deliberate edit, with an owning record to add to, not slip in unexercised.</summary>
    [Fact]
    public void EveryDiscriminatorBearingArrayColumn_IsOneThisTestExercises()
    {
        var found = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)
            .SelectMany(s => s.Value.RecordColumns.Select(c => (Table: s.Key, Column: c)))
            .Where(x => x.Column.ElementType?.Fields?.Any(f => f.IsDiscriminator) == true)
            .Select(x => $"{x.Table}.{x.Column.Name}")
            .OrderBy(n => n, StringComparer.Ordinal);

        Assert.Equal(["aech.effects", "omod.properties", "perk.effects", "qust.aliases"], found);
    }

    public static TheoryData<string, string> UnionArrays() => new()
    {
        { "qust", "aliases" },
        { "perk", "effects" },
        { "aech", "effects" },
        { "omod", "properties" },
    };

    [Theory]
    [MemberData(nameof(UnionArrays))]
    public void ArrayAdd_BuildsAnElementTheWritePathAccepts(string table, string column)
    {
        var mod = new Fallout4Mod(Key, Fallout4Release.Fallout4);
        var schema = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table];
        var col = schema.RecordColumns.Single(c => c.Name == column);
        var record = NewRecord(mod, table);

        var outcome = ArrayOpWriter.Apply(record, col, "array_add",
            JsonDocument.Parse("""{"op": "array_add", "path": []}""").RootElement);

        Assert.Equal(FieldApplyOutcome.Applied, outcome);
        var written = JsonDocument.Parse((string)col.Extract(record)!).RootElement;
        Assert.Equal(1, written.GetArrayLength());
        // The one member the default names, and the leaf it names.
        var discriminator = col.ElementType!.Fields!.Single(f => f.IsDiscriminator);
        Assert.Equal(
            discriminator.EnumMembers[0].Value,
            written[0].GetProperty(discriminator.Name).GetString());
    }

    private static IMajorRecord NewRecord(Fallout4Mod mod, string table) => table switch
    {
        "qust" => new Quest(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        "perk" => new Perk(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        "aech" => new AudioEffectChain(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        "omod" => new ArmorModification(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        _ => throw new ArgumentOutOfRangeException(nameof(table), table, "no record for this table"),
    };
}
