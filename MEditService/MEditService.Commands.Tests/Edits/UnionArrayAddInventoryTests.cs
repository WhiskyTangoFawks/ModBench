using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>The document-edit seam on an in-memory record's document, no plugin on disk: whether
/// the default element names a leaf the codec builds is settled before anything is written.</summary>
public class UnionArrayAddInventoryTests
{
    private static readonly ModKey Key = ModKey.FromFileName("UnionArrayAdd710.esp");

    [Fact]
    public void EveryDiscriminatorBearingArrayShape_IsOneThisTestExercises()
    {
        var found = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .SelectMany(s => s.RecordColumns)
            .Where(c => c.Field.ElementSpec?.SubFields?.Any(f => f.IsDiscriminator) == true)
            .Select(c => string.Join("|", c.Field.ElementSpec.Require().SubFields.Require().Single(f => f.IsDiscriminator)
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
        + "ObjectModStringProperty<Armor+Property>|ObjectModFormLinkIntProperty<Armor+Property>|"
        + "ObjectModFormLinkFloatProperty<Armor+Property>|ObjectModEnumProperty<Armor+Property>",
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
    public void ArrayAdd_BuildsAnElementTheCodecAccepts(string table, string column)
    {
        using var fixture = new DocumentEditFixture();
        var mod = new Fallout4Mod(Key, Fallout4Release.Fallout4);
        var schema = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table];
        var col = schema.RecordColumns.Single(c => c.Name == column);
        var formKey = fixture.Seed(NewRecord(mod, table), table);

        var (result, after) = fixture.Apply(formKey, Envelopes.AddAt(Envelopes.Member(column)));

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(after);
        using var document = JsonDocument.Parse(after);
        var written = document.RootElement.GetProperty(col.PropertyName);
        Assert.Equal(1, written.GetArrayLength());
        // The one member the default names, and the leaf it names.
        var discriminator = col.Field.ElementSpec.Require().SubFields.Require().Single(f => f.IsDiscriminator);
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
