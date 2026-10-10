using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class ValueRefusalTests : IDisposable
{
    private const string Npc = "000801:DocEdit.esp";
    private const string ArmorMod = "000802:DocEdit.esp";
    private const string GameSetting = "000803:DocEdit.esp";
    private const string MiscItem = "000804:DocEdit.esp";
    private const string SceneCollection = "000805:DocEdit.esp";
    private const string MaterialObject = "000806:DocEdit.esp";
    private const string Quest = "000807:DocEdit.esp";
    private const string GlobalShort = "000808:DocEdit.esp";
    private const string Race = "000809:DocEdit.esp";
    private const string Faction = "00080A:DocEdit.esp";

    private readonly DocumentEditFixture _fixture = new();

    public ValueRefusalTests()
    {
        _fixture.Seed(new Npc(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Guy" }, "npc_");

        var armor = new ArmorModification(KeyOf(0x802), Fallout4Release.Fallout4) { EditorID = "ArmorMod" };
        armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f });
        _fixture.Seed(armor, "omod");

        _fixture.Seed(new GameSettingBool(KeyOf(0x803), Fallout4Release.Fallout4) { EditorID = "bTest", Data = true }, "gmst");
        _fixture.Seed(new MiscItem(KeyOf(0x804), Fallout4Release.Fallout4) { EditorID = "Misc", ComponentDisplayIndices = [1] }, "misc");
        _fixture.Seed(new SceneCollection(KeyOf(0x805), Fallout4Release.Fallout4) { EditorID = "Scco", XNAMs = [1L] }, "scco");

        var material = new MaterialObject(KeyOf(0x806), Fallout4Release.Fallout4) { EditorID = "Mato" };
        material.DNAMs.Add(new MemorySlice<byte>([0x01, 0x02]));
        _fixture.Seed(material, "mato");

        _fixture.Seed(new Quest(KeyOf(0x807), Fallout4Release.Fallout4) { EditorID = "Qust" }, "qust");
        _fixture.Seed(new Race(KeyOf(0x809), Fallout4Release.Fallout4) { EditorID = "Race" }, "race");
        _fixture.Seed(
            new Faction(KeyOf(0x80A), Fallout4Release.Fallout4)
            {
                EditorID = "Faction",
                VendorLocation = new LocationTargetRadius { Radius = 1, Target = new LocationFallback() },
            },
            "fact");
        _fixture.Seed(new GlobalShort(KeyOf(0x808), Fallout4Release.Fallout4) { EditorID = "GlobShort", Data = 5 }, "glob");
    }

    public void Dispose() => _fixture.Dispose();

    [Theory]
    [InlineData(Npc, "Flags", "\"NotANumber\"")]
    [InlineData(Npc, "Aggression", "\"NotARealAggressionLevel\"")]
    [InlineData(Npc, "Race", "\"not-a-formkey\"")]
    [InlineData(Npc, "Voice", "42")]
    [InlineData(Npc, "Keywords", "\"000801:DocEdit.esp\"")]
    [InlineData(Npc, "Weight", "0.5")]
    [InlineData(Npc, "Weight", """{"Thin":"not-a-number","Fat":0.5,"Muscular":0.3}""")]
    [InlineData(ArmorMod, "Properties", "99")]
    [InlineData(ArmorMod, "Properties", """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":"not-a-number","Value2":7,"FunctionType":"Set"}]""")]
    [InlineData(GameSetting, "Data", "2.5")]
    [InlineData(MiscItem, "ComponentDisplayIndices", "[3, 4096]")]
    [InlineData(MiscItem, "ComponentDisplayIndices", """[3, "nope"]""")]
    [InlineData(SceneCollection, "XNAMs", "[7, 9223372036854775808]")]
    [InlineData(MaterialObject, "DNAMs", """["0xAAZZ"]""")]
    [InlineData(Race, "Subgraphs", """[{"Role": "MT", "AnimationPaths": [{"nope": 1}]}, {"Role": "Weapon"}]""")]
    [InlineData(Faction, "VendorLocation", """{"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": "not-a-number"}}""")]
    public void AValueTheCodecCannotHold_IsRefusedAsCodecRejected_NamingTheField_AndWritesNothing(string record, string member, string value)
    {
        var result = _fixture.Refused(record, Spelled(RecordEditEnvelope.Set, member, value));

        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal(member, result.Path);
        Assert.Contains("the codec rejected", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ACodecRejection_QuotesTheCodecsReason()
    {
        var result = _fixture.Refused(MiscItem, Spelled(RecordEditEnvelope.Set, "ComponentDisplayIndices", "[3, 4096]"));

        Assert.Contains("overflow", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(Quest, "Aliases", """[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "Conditions": [{"ComparisonValue": 1.0}]}]""")]
    [InlineData(ArmorMod, "Properties", """[{"Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]""")]
    [InlineData(Npc, "Level", """{"Level": 20}""")]
    [InlineData(Npc, "VirtualMachineAdapter", """{"Scripts": [{"Name": "S", "Properties": [{"Name": "P", "Flags": "Edited", "Data": 1}]}]}""")]
    public void AnElementOfAUnionNamingNoLeaf_IsRefusedAsDiscriminatorInvalid_NamingTheDiscriminator_AndWritesNothing(string record, string member, string value)
    {
        var result = _fixture.Refused(record, Spelled(RecordEditEnvelope.Set, member, value));

        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, result.Refusal);
        Assert.Contains("MutagenObjectType", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFieldTheRecordsClassLacks_IsRefusedAsFieldNotFound_AndWritesNothing()
    {
        var result = _fixture.Refused(GlobalShort, Spelled(RecordEditEnvelope.Set, "OutputChar", "true"));

        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }
}
