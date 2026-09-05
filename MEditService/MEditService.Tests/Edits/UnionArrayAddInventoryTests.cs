using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary><see cref="ArrayOpWriter"/> is called on an in-memory record, no plugin on disk: whether
/// the default element names a constructible leaf is settled before anything is written.</summary>
public class UnionArrayAddInventoryTests
{
    private static readonly ModKey Key = ModKey.FromFileName("UnionArrayAdd710.esp");

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

    // Written out so a Mutagen change to any leaf set is a visible edit here.
    private static readonly string[] ExercisedShapes =
    [
        // cobj.conditions and every other condition-bearing column
        "ConditionFloat|ConditionGlobal",
        // omod.properties
        "ObjectModIntProperty<Armor+Property>|ObjectModFloatProperty<Armor+Property>|ObjectModBoolProperty<Armor+Property>|"
        + "ObjectModStringProperty<Armor+Property>|ObjectModEnumProperty<Armor+Property>|"
        + "ObjectModFormLinkIntProperty<Armor+Property>|ObjectModFormLinkFloatProperty<Armor+Property>",
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
        { "cobj", "Conditions" },
        { "qust", "Aliases" },
        { "perk", "Effects" },
        { "aech", "Effects" },
        { "omod", "Properties" },
    };

    [Theory]
    [MemberData(nameof(UnionArrays))]
    public async Task ArrayAdd_BuildsAnElementTheWritePathAccepts(string table, string column)
    {
        var mod = new Fallout4Mod(Key, Fallout4Release.Fallout4);
        var schema = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table];
        var col = schema.RecordColumns.Single(c => c.Name == column);
        var record = NewRecord(mod, table);

        var outcome = ArrayOpWriter.Apply(record, col, col.ToFieldMetadata(), "array_add",
            JsonDocument.Parse("""{"op": "array_add", "path": []}""").RootElement, current: null);

        Assert.Equal(FieldApplyOutcome.Applied, outcome);
        var body = await new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytesAsync(record, GameRelease.Fallout4);
        using var document = JsonDocument.Parse(body);
        var written = document.RootElement.GetProperty(col.PropertyName);
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
