using MEditService.Codec.Schema;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class LeafLabelTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static IReadOnlyDictionary<string, string?> DiscriminatorLabels(FieldMetadata field)
    {
        var fields = field.Fields
            ?? throw new InvalidOperationException($"Expected '{field.Name}' to have sub-fields.");
        return fields.Single(f => f.Name == "MutagenObjectType").EnumMembers.ToDictionary(m => m.Value, m => m.Label);
    }

    [Fact]
    public void ANpcLevelUnion_LabelsALeafSharingTheBasesWholeName_WithTheBasesOwnWords()
    {
        var labels = DiscriminatorLabels(Schemas["npc_"].RecordColumns.Single(c => c.Name == "Level").ToFieldMetadata());

        Assert.Equal("Npc Level", labels["NpcLevel"]);
    }

    [Fact]
    public void ANpcLevelUnion_LabelsALeafSharingNoWordsWithTheBase_WithAllOfTheLeafsOwnWords()
    {
        var labels = DiscriminatorLabels(Schemas["npc_"].RecordColumns.Single(c => c.Name == "Level").ToFieldMetadata());

        Assert.Equal("Pc Level Mult", labels["PcLevelMult"]);
    }

    [Fact]
    public void AQuestAliasUnion_DropsTheWordTheBaseAndLeafShareAtTheStart()
    {
        var aliases = Schemas["qust"].RecordColumns.Single(c => c.Name == "Aliases").Field.ElementSpec
            ?? throw new InvalidOperationException("Expected 'qust.Aliases' to have an array element spec.");
        var labels = DiscriminatorLabels(aliases.ToFieldMetadata());

        Assert.Equal("Reference", labels["QuestReferenceAlias"]);
        Assert.Equal("Collection", labels["QuestCollectionAlias"]);
    }

    [Fact]
    public void AMagicEffectArchetypeUnion_DropsTheWordsTheBaseAndLeafShareAtBothEnds()
    {
        var labels = DiscriminatorLabels(Schemas["mgef"].RecordColumns.Single(c => c.Name == "Archetype").ToFieldMetadata());

        Assert.Equal("Bound", labels["MagicEffectBoundArchetype"]);
    }
}
