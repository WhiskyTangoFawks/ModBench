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

    /// <summary>The inventory itself, asserted rather than discovered at run time: a sixth
    /// union-array shape must arrive here as a deliberate edit, with an owning record to add to,
    /// not slip in unexercised.
    ///
    /// <para>Identified by the leaf set the element's discriminator offers rather than by the
    /// owning column, because that is what the default element is built from — #692's condition
    /// lists are one shape carried by twenty columns (every condition-bearing record type), and
    /// twenty owning records would prove the same one thing twenty times.</para></summary>
    [Fact]
    public void EveryDiscriminatorBearingArrayShape_IsOneThisTestExercises()
    {
        var found = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .SelectMany(s => s.RecordColumns)
            .Where(c => c.ElementType?.Fields?.Any(f => f.IsDiscriminator) == true)
            .Select(c => string.Join("|", c.ElementType!.Fields!.Single(f => f.IsDiscriminator)
                .EnumMembers.Select(m => m.Value)))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal);

        Assert.Equal(ExercisedShapes, found);
    }

    /// <summary>The five leaf sets <see cref="UnionArrays"/> covers, in ordinal order, each written
    /// out so a Mutagen change to any one of them is a visible edit here.</summary>
    private static readonly string[] ExercisedShapes =
    [
        // cobj.conditions and every other condition-bearing column
        "ConditionFloat|ConditionGlobal",
        // omod.properties
        "Int|Float|Bool|String|Enum|FormIdInt|FormIdFloat",
        // perk.effects
        "PerkEntryPointModifyActorValue|PerkEntryPointModifyValue|PerkQuestEffect|PerkAbilityEffect|" +
        "PerkEntryPointAddRangeToValue|PerkEntryPointAbsoluteValue|PerkEntryPointAddLeveledItem|" +
        "PerkEntryPointAddActivateChoice|PerkEntryPointSelectSpell|PerkEntryPointSelectText|" +
        "PerkEntryPointSetText|PerkEntryPointModifyValues",
        // qust.aliases
        "QuestReferenceAlias|QuestLocationAlias|QuestCollectionAlias",
        // aech.effects
        "StateVariableFilterAudioEffect|OverdriveAudioEffect|DelayAudioEffect",
    ];

    public static TheoryData<string, string> UnionArrays() => new()
    {
        { "cobj", "conditions" },
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
            JsonDocument.Parse("""{"op": "array_add", "path": []}""").RootElement, out _);

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
        "cobj" => new ConstructibleObject(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        "qust" => new Quest(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        "perk" => new Perk(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        "aech" => new AudioEffectChain(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        "omod" => new ArmorModification(mod.GetNextFormKey(), Fallout4Release.Fallout4),
        _ => throw new ArgumentOutOfRangeException(nameof(table), table, "no record for this table"),
    };
}
