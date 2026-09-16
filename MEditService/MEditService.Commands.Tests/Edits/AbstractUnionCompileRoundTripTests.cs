using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Compile, not document text: read coverage does not imply write correctness, so each fact
/// reparses the written binary through Mutagen's reader.</summary>
public sealed class AbstractUnionCompileRoundTripTests : IDisposable
{
    private readonly AbstractUnionCompileFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private EditRecordHandler EditService() => _fixture.EditHandler;

    private PluginCompileService CompileService() => CompileServices.Over(_fixture.LoadOrder);

    private IFallout4ModGetter CompileAndReparse()
    {
        var result = CompileService().Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_fixture.ModFolder, AbstractUnionCompileFixture.PluginName);
        return (IFallout4ModGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(AbstractUnionCompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
    }

    // ── Npc.Level (ANpcLevel) — a mandatory type, closing its compile-round-trip gap ──

    [Fact]
    public void Level_EditingWithinSameConcreteType_CompilesAndReparsesTheNewValue()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "Level",
            Json("""{"MutagenObjectType": "NpcLevel", "Level": 20}"""));
        Assert.True(result.Applied, result.Message);

        var npc = CompileAndReparse().Npcs.Single(n => n.FormKey == _fixture.Npc);
        Assert.IsType<NpcLevel>(npc.Level);
        Assert.Equal((byte)20, ((INpcLevelGetter)npc.Level.Require()).Level);
    }

    [Fact]
    public void Level_SwitchingConcreteType_NpcLevelToPcLevelMult_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "Level",
            Json("""{"MutagenObjectType": "PcLevelMult", "LevelMult": 1.5}"""));
        Assert.True(result.Applied, result.Message);

        var npc = CompileAndReparse().Npcs.Single(n => n.FormKey == _fixture.Npc);
        var mult = Assert.IsType<PcLevelMult>(npc.Level);
        Assert.Equal(1.5f, mult.LevelMult);
    }

    // ── Quest.Aliases (AQuestAlias) — a mandatory type, closing its compile-round-trip gap ──

    [Fact]
    public void Aliases_WholeArrayWrite_QuestReferenceAliasElement_CompilesAndReparsesTheNewElement()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Aliases",
            Json("""[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4}]"""));
        Assert.True(result.Applied, result.Message);

        var quest = CompileAndReparse().Quests.Single(q => q.FormKey == _fixture.Quest);
        var alias = Assert.Single(quest.Aliases.Require());
        // Quest alias elements stay lazy `...BinaryOverlay` instances until touched (confirmed by
        // AbstractUnionRealDataTests' own doc comment) — asserted through the getter interface, not
        // the concrete eager class, the same reason that file's own real-fixture read test does.
        var refAlias = Assert.IsAssignableFrom<IQuestReferenceAliasGetter>(alias);
        Assert.Equal("NewRef", refAlias.Name);
        Assert.Equal(4, refAlias.ClosestToAlias);
    }

    // ── Book.Teaches (BookTeachTarget) ──────────────────────────────────────────

    [Fact]
    public void Teaches_SwitchingConcreteType_SpellToPerk_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Book.ToString(), "Teaches",
            Json($$"""{"MutagenObjectType": "BookPerk", "Perk": "{{_fixture.Perk}}"}"""));
        Assert.True(result.Applied, result.Message);

        var book = CompileAndReparse().Books.Single(b => b.FormKey == _fixture.Book);
        var teaches = Assert.IsType<BookPerk>(book.Teaches);
        Assert.Equal(_fixture.Perk, teaches.Perk.FormKey);
    }

    // ── ColorRecord.Data (AColorRecordData) ─────────────────────────────────────

    [Fact]
    public void Data_EditingWithinSameConcreteType_IndexEdit_CompilesAndReparsesTheNewIndex()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.ColorRecord.ToString(), "Data",
            Json("""{"MutagenObjectType": "ColorRemappingIndex", "Index": 7.5}"""));
        Assert.True(result.Applied, result.Message);

        var color = CompileAndReparse().Colors.Single(c => c.FormKey == _fixture.ColorRecord);
        var remap = Assert.IsType<ColorRemappingIndex>(color.Data);
        Assert.Equal(7.5f, remap.Index);
    }

    [Fact]
    public void Data_SwitchingConcreteType_IndexToColorData_CompilesAndReparsesTheNewColorValue()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.ColorRecord.ToString(), "Data",
            Json("""{"MutagenObjectType": "ColorData", "Color": "#112233"}"""));
        Assert.True(result.Applied, result.Message);

        var color = CompileAndReparse().Colors.Single(c => c.FormKey == _fixture.ColorRecord);
        var colorData = Assert.IsType<ColorData>(color.Data);
        Assert.Equal((17, 34, 51), (colorData.Color.R, colorData.Color.G, colorData.Color.B));
    }

    // ── Holotape.Data (AHolotapeData) ───────────────────────────────────────────

    [Fact]
    public void Data_SwitchingConcreteType_ProgramToSound_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Holotape.ToString(), "Data",
            Json($$"""{"MutagenObjectType": "HolotapeSound", "Sound": "{{_fixture.SoundDescriptor}}"}"""));
        Assert.True(result.Applied, result.Message);

        var holotape = CompileAndReparse().Holotapes.Single(h => h.FormKey == _fixture.Holotape);
        var sound = Assert.IsType<HolotapeSound>(holotape.Data);
        Assert.Equal(_fixture.SoundDescriptor, sound.Sound.FormKey);
    }

    // ── SoundDescriptor.Data (ASoundDescriptor) ─────────────────────────────────

    [Fact]
    public void Data_EditingWithinSameConcreteType_StandardDataFields_CompileAndReparse()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.SoundDescriptor.ToString(), "Data",
            Json("""
            {"MutagenObjectType": "SoundDescriptorStandardData", "PercentFrequencyShift": 5,
             "PercentFrequencyVariance": 9, "Priority": 20, "Variance": 30,
             "StaticAttenuation": 2.5}
            """));
        Assert.True(result.Applied, result.Message);

        var sd = CompileAndReparse().SoundDescriptors.Single(s => s.FormKey == _fixture.SoundDescriptor);
        var data = Assert.IsType<SoundDescriptorStandardData>(sd.Data);
        Assert.Equal((sbyte)5, data.PercentFrequencyShift);
        Assert.Equal((sbyte)9, data.PercentFrequencyVariance);
        Assert.Equal((byte)20, data.Priority);
        Assert.Equal((byte)30, data.Variance);
        Assert.Equal(2.5f, data.StaticAttenuation, 2);
    }

    [Fact]
    public void Data_SwitchingConcreteType_StandardToCompound_CompilesAndReparsesAsTheDegenerateLeaf()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.SoundDescriptor.ToString(), "Data",
            Json("""{"MutagenObjectType": "SoundDescriptorCompoundData"}"""));
        Assert.True(result.Applied, result.Message);

        var sd = CompileAndReparse().SoundDescriptors.Single(s => s.FormKey == _fixture.SoundDescriptor);
        Assert.IsType<SoundDescriptorCompoundData>(sd.Data);
    }

    // ── Perk.Effects (APerkEffect / APerkEntryPointEffect) ──────────────────────

    [Fact]
    public void Effects_WholeArrayWrite_QuestEffectToAbilityEffect_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Perk.ToString(), "Effects",
            Json($$"""[{"MutagenObjectType": "PerkAbilityEffect", "Ability": "{{_fixture.Spell}}"}]"""));
        Assert.True(result.Applied, result.Message);

        var perk = CompileAndReparse().Perks.Single(p => p.FormKey == _fixture.Perk);
        var effect = Assert.Single(perk.Effects);
        var ability = Assert.IsType<PerkAbilityEffect>(effect);
        Assert.Equal(_fixture.Spell, ability.Ability.FormKey);
    }

    [Fact]
    public void Effects_WholeArrayWrite_ToTwoLevelEntryPointChainLeaf_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Perk.ToString(), "Effects",
            Json("""[{"MutagenObjectType": "PerkEntryPointAddRangeToValue", "From": 1.5, "To": 9.5}]"""));
        Assert.True(result.Applied, result.Message);

        var perk = CompileAndReparse().Perks.Single(p => p.FormKey == _fixture.Perk);
        var effect = Assert.Single(perk.Effects);
        var entryPoint = Assert.IsType<PerkEntryPointAddRangeToValue>(effect);
        Assert.Equal(1.5f, entryPoint.From);
        Assert.Equal(9.5f, entryPoint.To);
    }

    // ── MagicEffect.Archetype (AMagicEffectArchetype) ───────────────────────────

    [Fact]
    public void Archetype_SwitchingConcreteType_LightToPeakValueMod_CompilesAndReparsesTheNewAssociation()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.MagicEffect.ToString(), "Archetype",
            Json($$"""{"MutagenObjectType": "MagicEffectPeakValueModArchetype", "Association": "{{_fixture.Keyword}}"}"""));
        Assert.True(result.Applied, result.Message);

        var mgef = CompileAndReparse().MagicEffects.Single(m => m.FormKey == _fixture.MagicEffect);
        var archetype = Assert.IsType<MagicEffectPeakValueModArchetype>(mgef.Archetype);
        Assert.Equal(_fixture.Keyword, archetype.Association.FormKey);
    }

    [Fact]
    public void Archetype_BaseActorValueField_SurvivesAConcreteTypeSwitch_AndCompilesAndReparses()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.MagicEffect.ToString(), "Archetype",
            Json($$"""
            {"MutagenObjectType": "MagicEffectPeakValueModArchetype", "Association": "{{_fixture.Keyword}}",
             "ActorValue": "{{_fixture.ActorValueInformation}}"}
            """));
        Assert.True(result.Applied, result.Message);

        var mgef = CompileAndReparse().MagicEffects.Single(m => m.FormKey == _fixture.MagicEffect);
        var archetype = Assert.IsType<MagicEffectPeakValueModArchetype>(mgef.Archetype);
        Assert.Equal(_fixture.ActorValueInformation, archetype.ActorValue.FormKey);
    }

    // ValueModifier deliberately: every other Type has a named case in ReadArchetype and would
    // reparse as a more specific leaf, so only the default case rebuilds the literal base.
    [Fact]
    public void Archetype_SwitchingToTheBaseLeaf_ItsOwnRealTypeFieldCompilesAndReparses()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.MagicEffect.ToString(), "Archetype",
            Json($$"""
            {"MutagenObjectType": "MagicEffectArchetype", "Type": "ValueModifier",
             "Association": "{{_fixture.ActorValueInformation}}"}
            """));
        Assert.True(result.Applied, result.Message);

        var mgef = CompileAndReparse().MagicEffects.Single(m => m.FormKey == _fixture.MagicEffect);
        var archetype = Assert.IsType<MagicEffectArchetype>(mgef.Archetype);
        Assert.Equal(MagicEffectArchetype.TypeEnum.ValueModifier, archetype.Type);
    }

    // ── AudioEffectChain.Effects (AAudioEffect) ─────────────────────────────────

    [Fact]
    public void Effects_WholeArrayWrite_OverdriveToStateVariableFilter_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.AudioEffectChain.ToString(), "Effects",
            Json("""
            [{"MutagenObjectType": "StateVariableFilterAudioEffect", "Enabled": true,
              "CenterFrequency": 440.0, "QValue": 0.75}]
            """));
        Assert.True(result.Applied, result.Message);

        var aech = CompileAndReparse().AudioEffectChains.Single(a => a.FormKey == _fixture.AudioEffectChain);
        var effect = Assert.Single(aech.Effects);
        // AAudioEffect leaves stay lazy `...BinaryOverlay` instances the same way Quest's aliases do
        // (no `binaryOverlay="NoGeneration"` on this type, unlike MagicEffect's own archetypes) —
        // asserted through the getter interface, not the concrete eager class.
        var filter = Assert.IsAssignableFrom<IStateVariableFilterAudioEffectGetter>(effect);
        Assert.True(filter.Enabled);
        Assert.Equal(440.0f, filter.CenterFrequency);
        Assert.Equal(0.75f, filter.QValue);
    }

    // ── The two nested abstract unions — reached one level inside another struct column ──
    //
    // NearSelf, not NearReference: PLVD's binary discriminator is the Type value, so a
    // LocationFallback holding a known kind cannot survive a binary round trip as a fallback.

    [Fact]
    public void VendorLocationTarget_NestedStructEdit_CompilesAndReparsesTheNewValue()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json("""
            {"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": 3}}
            """));
        Assert.True(result.Applied, result.Message);

        var faction = CompileAndReparse().Factions.Single(f => f.FormKey == _fixture.Faction);
        var vendorLocation = faction.VendorLocation.Require();
        Assert.Equal(99u, vendorLocation.Radius);
        var target = Assert.IsAssignableFrom<ILocationFallbackGetter>(vendorLocation.Target);
        Assert.Equal(LocationTargetRadius.LocationType.NearSelf, target.Type);
        Assert.Equal(3, target.Data);
    }

    [Fact]
    public void NavmeshGeometryParent_SwitchingConcreteType_WorldspaceToCell_CompilesAndReparsesAsTheNewLeaf()
    {
        var result = EditService().Set(
            _fixture.Plugin, _fixture.Static.ToString(), "NavmeshGeometry",
            Json("""{"Parent": {"MutagenObjectType": "CellNavmeshParent"}}"""));
        Assert.True(result.Applied, result.Message);

        var stat = CompileAndReparse().Statics.Single(s => s.FormKey == _fixture.Static);
        Assert.IsAssignableFrom<ICellNavmeshParentGetter>(stat.NavmeshGeometry.Require().Parent);
    }
}
