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
    private readonly DocumentEditFixture _fixture = new();
    private readonly Dictionary<string, FormKey> _records = [];

    public AbstractUnionCompileRoundTripTests()
    {
        var mod = new Fallout4Mod(DocumentEditFixture.ModKey, Fallout4Release.Fallout4);
        var spell = mod.Spells.AddNew("Spell");
        var light = mod.Lights.AddNew("Light");
        Seed("Keyword", "kywd", mod.Keywords.AddNew("Keyword"));
        Seed("Spell", "spel", spell);
        Seed("Light", "ligh", light);
        Seed("ActorValueInformation", "avif", mod.ActorValueInformation.AddNew("ActorValueInformation"));

        var npc = mod.Npcs.AddNew("Npc");
        npc.Level = new NpcLevel { Level = 5 };
        Seed("Npc", "npc_", npc);

        var quest = mod.Quests.AddNew("Quest");
        quest.Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }];
        Seed("Quest", "qust", quest);

        var perk = mod.Perks.AddNew("Perk");
        var perkQuestEffect = new PerkQuestEffect { Stage = 7 };
        perkQuestEffect.Quest.SetTo(quest);
        perk.Effects.Add(perkQuestEffect);
        Seed("Perk", "perk", perk);

        var book = mod.Books.AddNew("Book");
        var bookSpell = new BookSpell();
        bookSpell.Spell.SetTo(spell);
        book.Teaches = bookSpell;
        Seed("Book", "book", book);

        var colorRecord = mod.Colors.AddNew("ColorRecord");
        colorRecord.Data = new ColorRemappingIndex { Index = 2.5f };
        Seed("ColorRecord", "clfm", colorRecord);

        var soundDescriptor = mod.SoundDescriptors.AddNew("SoundDescriptor");
        soundDescriptor.Data = new SoundDescriptorStandardData
        {
            PercentFrequencyShift = 1,
            PercentFrequencyVariance = 2,
            Priority = 3,
            Variance = 4,
            StaticAttenuation = 1.5f,
        };
        Seed("SoundDescriptor", "sndr", soundDescriptor);

        var holotape = mod.Holotapes.AddNew("Holotape");
        holotape.Data = new HolotapeProgram { File = "startup.txt" };
        Seed("Holotape", "note", holotape);

        var magicEffect = mod.MagicEffects.AddNew("MagicEffect");
        var lightArchetype = new MagicEffectLightArchetype();
        lightArchetype.Association.SetTo(light);
        magicEffect.Archetype = lightArchetype;
        Seed("MagicEffect", "mgef", magicEffect);

        var audioEffectChain = mod.AudioEffectChains.AddNew("AudioEffectChain");
        audioEffectChain.Effects.Add(new OverdriveAudioEffect
        {
            Enabled = true,
            InputGain = 1f,
            OutputGain = 2f,
            UpperThreshold = 3f,
            LowerThreshold = 4f,
        });
        Seed("AudioEffectChain", "aech", audioEffectChain);

        var faction = mod.Factions.AddNew("Faction");
        faction.VendorLocation = new LocationTargetRadius
        {
            Radius = 1,
            Target = new LocationFallback { Type = LocationTargetRadius.LocationType.NearReference, Data = 0 },
        };
        Seed("Faction", "fact", faction);
    }

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private void Seed(string name, string recordType, IMajorRecordGetter record)
    {
        _fixture.Seed(record, recordType);
        _records[name] = record.FormKey;
    }

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
        var formKey = _records[subject].ToString();
        var edited = _fixture.EditHandler.Set(_fixture.Plugin, formKey, member, Json(PlaceholdersFilled(value)));
        Assert.True(edited.Applied, edited.Message);
        var document = _fixture.Document(formKey);

        await CompileServices.Over(_fixture.LoadOrder).CompileLandedAsync(_fixture.Plugin);

        var path = Path.Combine(_fixture.ModFolderOf(_fixture.Plugin), _fixture.Plugin.Name);
        var reparsed = (IFallout4ModGetter)ModFactory.ImportGetter(new ModPath(DocumentEditFixture.ModKey, path), GameRelease.Fallout4);
        var record = reparsed.EnumerateMajorRecords().Single(candidate => candidate.FormKey.ToString() == formKey);
        var compiled = RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);
        Assert.Empty(DocumentDiffs.Of(MemberOf(document, member), MemberOf(compiled, member)));
    }

    private static string MemberOf(string document, string member) =>
        JsonNode.Parse(document).Require()[member].Require().ToJsonString();

    private string PlaceholdersFilled(string value) =>
        Placeholder().Replace(value, match => _records[match.Groups[1].Value].ToString());

    [GeneratedRegex(@"\{(\w+)\}")]
    private static partial Regex Placeholder();
}
