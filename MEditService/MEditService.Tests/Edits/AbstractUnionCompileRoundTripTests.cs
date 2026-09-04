using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Compile, not document text: read coverage does not imply write correctness (#360), so each fact
/// reparses the written binary through Mutagen's reader.</summary>
public sealed class AbstractUnionCompileRoundTripTests : IDisposable
{
    private readonly AbstractUnionCompileFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private PluginCompileService CompileService() =>
        new(_fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    private IFallout4ModGetter CompileAndReparse()
    {
        var result = CompileService().Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_fixture.ModFolder, AbstractUnionCompileFixture.PluginName);
        return (IFallout4ModGetter)ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(AbstractUnionCompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
    }

    // ── Npc.Level (ANpcLevel) — #548's own mandatory type, closing its compile-round-trip gap ──

    [Fact]
    public void Level_EditingWithinSameConcreteType_CompilesAndReparsesTheNewValue()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "level",
            Json("""{"level": 20, "concrete_type": "NpcLevel"}"""));
        Assert.True(result.Applied, result.Message);

        var npc = CompileAndReparse().Npcs.Single(n => n.FormKey == _fixture.Npc);
        Assert.IsType<NpcLevel>(npc.Level);
        Assert.Equal((byte)20, ((INpcLevelGetter)npc.Level!).Level);
    }

    [Fact]
    public void Level_SwitchingConcreteType_NpcLevelToPcLevelMult_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Npc.ToString(), "level",
            Json("""{"level_mult": 1.5, "concrete_type": "PcLevelMult"}"""));
        Assert.True(result.Applied, result.Message);

        var npc = CompileAndReparse().Npcs.Single(n => n.FormKey == _fixture.Npc);
        var mult = Assert.IsType<PcLevelMult>(npc.Level);
        Assert.Equal(1.5f, mult.LevelMult);
    }

    // ── Quest.Aliases (AQuestAlias) — #548's own mandatory type, closing its compile-round-trip gap ──

    [Fact]
    public void Aliases_WholeArrayWrite_QuestReferenceAliasElement_CompilesAndReparsesTheNewElement()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Quest.ToString(), "aliases",
            Json("""[{"concrete_type": "QuestReferenceAlias", "name": "NewRef", "closest_to_alias": 4}]"""));
        Assert.True(result.Applied, result.Message);

        var quest = CompileAndReparse().Quests.Single(q => q.FormKey == _fixture.Quest);
        var alias = Assert.Single(quest.Aliases!);
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
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Book.ToString(), "teaches",
            Json($$"""{"concrete_type": "BookPerk", "perk": "{{_fixture.Perk}}"}"""));
        Assert.True(result.Applied, result.Message);

        var book = CompileAndReparse().Books.Single(b => b.FormKey == _fixture.Book);
        var teaches = Assert.IsType<BookPerk>(book.Teaches);
        Assert.Equal(_fixture.Perk, teaches.Perk.FormKey);
    }

    // ── ColorRecord.Data (AColorRecordData) ─────────────────────────────────────

    [Fact]
    public void Data_EditingWithinSameConcreteType_IndexEdit_CompilesAndReparsesTheNewIndex()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.ColorRecord.ToString(), "data",
            Json("""{"concrete_type": "ColorRemappingIndex", "index": 7.5}"""));
        Assert.True(result.Applied, result.Message);

        var color = CompileAndReparse().Colors.Single(c => c.FormKey == _fixture.ColorRecord);
        var remap = Assert.IsType<ColorRemappingIndex>(color.Data);
        Assert.Equal(7.5f, remap.Index);
    }

    [Fact]
    public void Data_SwitchingConcreteType_IndexToColorData_CompilesAndReparsesTheNewColorValue()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.ColorRecord.ToString(), "data",
            Json("""{"concrete_type": "ColorData", "color": {"red": 17, "green": 34, "blue": 51}}"""));
        Assert.True(result.Applied, result.Message);

        var color = CompileAndReparse().Colors.Single(c => c.FormKey == _fixture.ColorRecord);
        var colorData = Assert.IsType<ColorData>(color.Data);
        Assert.Equal((17, 34, 51), (colorData.Color.R, colorData.Color.G, colorData.Color.B));
    }

    // ── Holotape.Data (AHolotapeData) ───────────────────────────────────────────

    [Fact]
    public void Data_SwitchingConcreteType_ProgramToSound_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Holotape.ToString(), "data",
            Json($$"""{"concrete_type": "HolotapeSound", "sound": "{{_fixture.SoundDescriptor}}"}"""));
        Assert.True(result.Applied, result.Message);

        var holotape = CompileAndReparse().Holotapes.Single(h => h.FormKey == _fixture.Holotape);
        var sound = Assert.IsType<HolotapeSound>(holotape.Data);
        Assert.Equal(_fixture.SoundDescriptor, sound.Sound.FormKey);
    }

    // ── SoundDescriptor.Data (ASoundDescriptor) ─────────────────────────────────

    [Fact]
    public void Data_EditingWithinSameConcreteType_StandardDataFields_CompileAndReparse()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.SoundDescriptor.ToString(), "data",
            Json("""
            {"concrete_type": "SoundDescriptorStandardData", "percent_frequency_shift": 5,
             "percent_frequency_variance": 9, "priority": 20, "variance": 30,
             "static_attenuation": 2.5}
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
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.SoundDescriptor.ToString(), "data",
            Json("""{"concrete_type": "SoundDescriptorCompoundData"}"""));
        Assert.True(result.Applied, result.Message);

        var sd = CompileAndReparse().SoundDescriptors.Single(s => s.FormKey == _fixture.SoundDescriptor);
        Assert.IsType<SoundDescriptorCompoundData>(sd.Data);
    }

    // ── Perk.Effects (APerkEffect / APerkEntryPointEffect) ──────────────────────

    [Fact]
    public void Effects_WholeArrayWrite_QuestEffectToAbilityEffect_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Perk.ToString(), "effects",
            Json($$"""[{"concrete_type": "PerkAbilityEffect", "ability": "{{_fixture.Spell}}"}]"""));
        Assert.True(result.Applied, result.Message);

        var perk = CompileAndReparse().Perks.Single(p => p.FormKey == _fixture.Perk);
        var effect = Assert.Single(perk.Effects);
        var ability = Assert.IsType<PerkAbilityEffect>(effect);
        Assert.Equal(_fixture.Spell, ability.Ability.FormKey);
    }

    [Fact]
    public void Effects_WholeArrayWrite_ToTwoLevelEntryPointChainLeaf_CompilesAndReparsesAsTheNewConcreteType()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Perk.ToString(), "effects",
            Json("""[{"concrete_type": "PerkEntryPointAddRangeToValue", "from": 1.5, "to": 9.5}]"""));
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
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.MagicEffect.ToString(), "archetype",
            Json($$"""{"concrete_type": "MagicEffectPeakValueModArchetype", "association": "{{_fixture.Keyword}}"}"""));
        Assert.True(result.Applied, result.Message);

        var mgef = CompileAndReparse().MagicEffects.Single(m => m.FormKey == _fixture.MagicEffect);
        var archetype = Assert.IsType<MagicEffectPeakValueModArchetype>(mgef.Archetype);
        Assert.Equal(_fixture.Keyword, archetype.Association.FormKey);
    }

    [Fact]
    public void Archetype_BaseActorValueField_SurvivesAConcreteTypeSwitch_AndCompilesAndReparses()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.MagicEffect.ToString(), "archetype",
            Json($$"""
            {"concrete_type": "MagicEffectPeakValueModArchetype", "association": "{{_fixture.Keyword}}",
             "actor_value": "{{_fixture.ActorValueInformation}}"}
            """));
        Assert.True(result.Applied, result.Message);

        var mgef = CompileAndReparse().MagicEffects.Single(m => m.FormKey == _fixture.MagicEffect);
        var archetype = Assert.IsType<MagicEffectPeakValueModArchetype>(mgef.Archetype);
        Assert.Equal(_fixture.ActorValueInformation, archetype.ActorValue.FormKey);
    }

    [Fact]
    public void Archetype_SwitchingToTheBaseLeaf_ItsOwnRealTypeFieldCompilesAndReparses()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.MagicEffect.ToString(), "archetype",
            Json($$"""
            {"concrete_type": "MagicEffectArchetype", "type": "ValueModifier",
             "association": "{{_fixture.ActorValueInformation}}"}
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
        // "qvalue", not "q_value" — ReflectedTypes.ToSnakeCase only inserts an underscore before an
        // uppercase letter preceded by a lowercase/digit ((?<=[a-z0-9])([A-Z])); "QValue"'s two
        // adjacent capitals never trip that lookbehind, so it lowercases straight through.
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.AudioEffectChain.ToString(), "effects",
            Json("""
            [{"concrete_type": "StateVariableFilterAudioEffect", "enabled": true,
              "center_frequency": 440.0, "qvalue": 0.75}]
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

    // ── #643: the two nested abstract unions — reached one level inside another struct column ──

    [Fact]
    public void VendorLocationTarget_NestedStructEdit_CompilesAndReparsesTheNewValue()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""
            {"radius": 99, "target": {"concrete_type": "LocationFallback", "type": "NearSelf", "data": 3}}
            """));
        Assert.True(result.Applied, result.Message);

        var faction = CompileAndReparse().Factions.Single(f => f.FormKey == _fixture.Faction);
        Assert.Equal(99u, faction.VendorLocation!.Radius);
        var target = Assert.IsAssignableFrom<ILocationFallbackGetter>(faction.VendorLocation.Target);
        Assert.Equal(LocationTargetRadius.LocationType.NearSelf, target.Type);
        Assert.Equal(3, target.Data);
    }

    [Fact]
    public void NavmeshGeometryParent_SwitchingConcreteType_WorldspaceToCell_CompilesAndReparsesAsTheNewLeaf()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.Static.ToString(), "navmesh_geometry",
            Json("""{"parent": {"concrete_type": "CellNavmeshParent"}}"""));
        Assert.True(result.Applied, result.Message);

        var stat = CompileAndReparse().Statics.Single(s => s.FormKey == _fixture.Static);
        Assert.IsAssignableFrom<ICellNavmeshParentGetter>(stat.NavmeshGeometry!.Parent);
    }
}
