using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed partial class AbstractUnionCompileRoundTripTests : IDisposable
{
    private readonly AbstractUnionCompileFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Theory]
    [InlineData("Npc", "Level", """{"MutagenObjectType": "NpcLevel", "Level": 20}""")]
    [InlineData("Npc", "Level", """{"MutagenObjectType": "PcLevelMult", "LevelMult": 1.5}""")]
    [InlineData("Quest", "Aliases", """[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4}]""")]
    [InlineData("Quest", "Aliases", """[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4, "Location": {"AliasID": 9}}]""")]
    [InlineData("Book", "Teaches", """{"MutagenObjectType": "BookPerk", "Perk": "{Perk}"}""")]
    [InlineData("ColorRecord", "Data", """{"MutagenObjectType": "ColorRemappingIndex", "Index": 7.5}""")]
    [InlineData("ColorRecord", "Data", """{"MutagenObjectType": "ColorData", "Color": "#112233"}""")]
    [InlineData("Holotape", "Data", """{"MutagenObjectType": "HolotapeSound", "Sound": "{SoundDescriptor}"}""")]
    [InlineData("SoundDescriptor", "Data", """{"MutagenObjectType": "SoundDescriptorStandardData", "PercentFrequencyShift": 5, "PercentFrequencyVariance": 9, "Priority": 20, "Variance": 30, "StaticAttenuation": 2.5}""")]
    [InlineData("SoundDescriptor", "Data", """{"MutagenObjectType": "SoundDescriptorCompoundData"}""")]
    [InlineData("Perk", "Effects", """[{"MutagenObjectType": "PerkAbilityEffect", "Ability": "{Spell}"}]""")]
    [InlineData("Perk", "Effects", """[{"MutagenObjectType": "PerkEntryPointAddRangeToValue", "From": 1.5, "To": 9.5}]""")]
    [InlineData("MagicEffect", "Archetype", """{"MutagenObjectType": "MagicEffectPeakValueModArchetype", "Association": "{Keyword}"}""")]
    [InlineData("MagicEffect", "Archetype", """{"MutagenObjectType": "MagicEffectPeakValueModArchetype", "Association": "{Keyword}", "ActorValue": "{ActorValueInformation}"}""")]
    [InlineData("MagicEffect", "Archetype", """{"MutagenObjectType": "MagicEffectArchetype", "Type": "ValueModifier", "Association": "{ActorValueInformation}"}""")]
    [InlineData("AudioEffectChain", "Effects", """[{"MutagenObjectType": "StateVariableFilterAudioEffect", "Enabled": true, "CenterFrequency": 440.0, "QValue": 0.75}]""")]
    [InlineData("Faction", "VendorLocation", """{"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": 3}}""")]
    public async Task AnEditedUnion_CompilesAndReparsesAsTheDocumentReads(string subject, string member, string value)
    {
        var formKey = Property(subject).ToString();
        var edited = _fixture.EditHandler.Set(_fixture.Plugin, formKey, member, Json(PlaceholdersFilled(value)));
        Assert.True(edited.Applied, edited.Message);
        var document = TrackedTree.Body(_fixture.ModFolder, _fixture.Plugin, formKey);

        await CompileServices.Over(_fixture.LoadOrder).CompileLandedAsync(_fixture.Plugin);

        var reparsed = (IFallout4ModGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(AbstractUnionCompileFixture.PluginName), Path.Combine(_fixture.ModFolder, AbstractUnionCompileFixture.PluginName)),
            GameRelease.Fallout4);
        var record = reparsed.EnumerateMajorRecords().Single(candidate => candidate.FormKey.ToString() == formKey);
        var compiled = RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);
        Assert.Empty(DocumentDiffs.Of(MemberOf(document, member), MemberOf(compiled, member)));
    }

    private static string MemberOf(string document, string member) =>
        JsonNode.Parse(document).Require()[member].Require().ToJsonString();

    private FormKey Property(string name) =>
        (FormKey)(typeof(AbstractUnionCompileFixture).GetProperty(name)?.GetValue(_fixture)
            ?? throw new InvalidOperationException($"Expected the fixture to hold '{name}'."));

    private string PlaceholdersFilled(string value) =>
        Placeholder().Replace(value, match => Property(match.Groups[1].Value).ToString());

    [GeneratedRegex(@"\{(\w+)\}")]
    private static partial Regex Placeholder();
}
