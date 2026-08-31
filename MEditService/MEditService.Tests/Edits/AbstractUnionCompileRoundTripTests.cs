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

/// <summary>
/// #611: the write half of #548's general abstract-union mechanism, for every type the mechanism's
/// own completeness census
/// (<see cref="MEditService.Tests.Indexing.SchemaReflectorLeafCoverageCompletenessTests"/>'s
/// <c>CoveredAbstractUnions</c>/<c>CoveredNestedAbstractUnions</c>) proved covered on the *read* side
/// only, plus #548's own two mandatory types (<c>Npc.Level</c>, <c>Quest.Aliases</c>) — those two
/// already have document-level coverage (<see cref="AbstractUnionEditTests"/>), but never a compile.
/// #360's own precedent (read coverage does not imply write correctness) is why every one of these
/// gets its own hand-verification here rather than trusting the general mechanism's read-side proof.
///
/// <para><b>Compile, not document text.</b> Each fact edits a field, compiles through the real
/// <see cref="PluginCompileService"/>, and reparses the written binary through
/// <see cref="ModFactory.ImportGetter"/> — the same shape
/// <c>PluginCompileServiceTests.Compile_AfterAnEdit_WritesABinaryThatReparsesWithTheChangeLanded</c>
/// already established for plain fields, extended here to abstract-union discriminator resolution. A
/// literal whole-plugin byte comparison isn't meaningful for compile output at all
/// (<c>RealData/CompileRoundTripGateTests</c>'s own doc comment: compile builds from source text, not
/// an existing binary, so there is no "original binary" to byte-match) — "byte-identical" for this
/// suite means the specific field's own bytes reparse, through Mutagen's own binary reader, to the
/// exact concrete CLR type and values that were written. A document-substring check (what
/// <see cref="AbstractUnionEditTests"/> itself does for its two types) only proves the document layer,
/// which already worked before this ticket — it cannot be the layer #360's precedent warns about.</para>
///
/// <para>One shared, once-tracked mod (<see cref="AbstractUnionCompileFixture"/>) holds one record of
/// every owning type plus a small supporting cast (Keyword/Spell/Light/ActorValueInformation) for the
/// FormLink targets several leaves carry — every FormLink written here points at a real, correctly
/// typed record, the same posture <c>ComplexFieldElementEditTests.FactionsStructArray...</c> takes,
/// because ADR-0041's Dangling/Type-Mismatched FormLink refusal would otherwise refuse for a reason
/// that has nothing to do with what a given fact is testing.</para>
///
/// <para><b>Two of the nine byproduct types are not here</b> — <c>NavmeshGeometry.Parent</c> and
/// <c>LocationTargetRadius.Target</c>. Both are reached one level *inside* another struct column
/// (<c>Static.NavmeshGeometry</c> / <c>Faction.VendorLocation</c>), and
/// <c>SchemaReflector.BuildStructSubField</c> — the builder for a Loqui struct nested inside another
/// struct/array column — returns <c>Apply: null</c> unconditionally for every nested struct, abstract
/// union or not (its own doc comment: "nested Loqui structs are read-only"). #548's write-side
/// generalization reached <c>BuildStructColumn</c> (a top-level struct column) and <c>ApplyListJson</c>
/// (a top-level list column) — never <c>BuildStructSubField</c> — so these two types have <i>no write
/// path through <see cref="RecordEditService.EditField"/> at all today</i>: a payload naming their own
/// nested field is silently accepted-and-ignored by <c>ApplySubFields</c>'s own no-<c>Apply</c> skip,
/// the same as any other read-only sub-field. This is the read/write divergence #360's precedent warns
/// about — reported to the orchestrator rather than fixed here, per that ticket's own instruction not
/// to repair a real bug silently inside a test-adding ticket.</para>
///
/// <para><c>ColorRecord.Data</c>'s <c>ColorData</c> leaf is included, but its round trip is
/// discriminator-only: <c>System.Drawing.Color</c> is a shape <c>SchemaReflector</c> has never
/// reflected anywhere in the schema (filed as #641, general, not specific to this mechanism), so the
/// <c>ColorData</c> leaf contributes zero real sub-fields today — see
/// <see cref="Data_SwitchingConcreteType_IndexToColorData_CompilesAndReparsesAsColorDataWithNoColorField"/>'s
/// own doc comment.</para>
/// </summary>
public sealed class AbstractUnionCompileRoundTripTests : IDisposable
{
    private readonly AbstractUnionCompileFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private PluginCompileService CompileService() =>
        new(_fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    /// <summary>Compiles the working tree and reparses the written binary through the same
    /// binary-overlay door <see cref="PluginCompileServiceTests"/> already uses.</summary>
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

    /// <summary>
    /// #641: <c>ColorData</c>'s own <c>Color</c> member is a <c>System.Drawing.Color</c> —
    /// <c>SchemaReflector</c> has never reflected that shape anywhere in the schema, so this leaf
    /// contributes zero real sub-fields today. This fact can only prove the discriminator itself
    /// switches correctly on compile; it is deliberately not asserting on any color value, because
    /// there is no field this write door can set one through. Not a regression this ticket
    /// introduces — every other <c>Color</c>-typed field in the schema has the identical gap.
    /// </summary>
    [Fact]
    public void Data_SwitchingConcreteType_IndexToColorData_CompilesAndReparsesAsColorDataWithNoColorField()
    {
        var result = EditService().EditField(
            _fixture.Plugin, _fixture.ColorRecord.ToString(), "data",
            Json("""{"concrete_type": "ColorData"}"""));
        Assert.True(result.Applied, result.Message);

        var color = CompileAndReparse().Colors.Single(c => c.FormKey == _fixture.ColorRecord);
        Assert.IsType<ColorData>(color.Data);
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

    /// <summary><c>SoundDescriptorCompoundData</c> is the degenerate leaf (zero own fields, same
    /// shape as <c>QuestCollectionAlias</c>/<c>PcLevelMult</c> already prove elsewhere) — this fact
    /// pins that switching *to* it actually discards the standard leaf's own data rather than
    /// leaving stale fields on a reused object.</summary>
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

    /// <summary>
    /// <c>PerkEntryPointAddRangeToValue</c> inherits <c>APerkEffect</c> through the two-level
    /// <c>APerkEntryPointEffect</c> chain — <c>FindAbstractUnionLeaves</c>' own doc comment says
    /// <c>IsAssignableFrom</c>'s transitivity finds this the same way it finds a one-level leaf, with
    /// no depth-specific code; this fact is the write-side half of that claim.
    /// </summary>
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

    /// <summary><c>ActorValue</c> is declared on the abstract base itself
    /// (<c>AMagicEffectArchetype</c>, hand-written <c>binary="NoGeneration"</c>) and shared, unmerged,
    /// across every leaf — a genuine #360-style round-trip risk distinct from each leaf's own
    /// <c>Association</c>, so it gets its own assertion here rather than folding into the leaf-switch
    /// fact above.</summary>
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

    /// <summary>
    /// The literal "MagicEffectArchetype" leaf (Mutagen's own default/base-named concrete class) is
    /// the *only* one of the nine leaves whose own <c>Type</c> is real, settable data — every other
    /// leaf's <c>Type</c> (e.g. <c>MagicEffectLightArchetype.Type =&gt; TypeEnum.Light</c>) is a
    /// hand-written, get-only constant declared on the concrete class itself, outside its own getter
    /// interface (<c>IMagicEffectLightArchetypeGetter</c> declares only <c>Association</c>) — so
    /// <c>SchemaReflector</c>'s reflection walk never sees it at all for those leaves, and the
    /// schema's own <c>type</c> sub-field is null there, not merely read-only. This fact is the one
    /// place <c>type</c> is real data to round-trip.
    /// </summary>
    /// <summary>
    /// <c>ValueModifier</c> deliberately, not a type with its own dedicated leaf class
    /// (<c>EnhanceWeapon</c>/<c>Light</c>/... each construct their own specific class on Mutagen's own
    /// binary read — <c>MagicEffectBinaryCreateTranslation.ReadArchetype</c>'s named cases — so a
    /// value from that set would reparse as a *more specific* leaf than what was written, which is
    /// correct Mutagen behavior but would defeat this fact's own point). <c>ValueModifier</c> falls to
    /// <c>ReadArchetype</c>'s <c>default:</c> case, the one path that reconstructs the literal
    /// <c>MagicEffectArchetype</c> class this fact means to round-trip.
    /// </summary>
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
        // "qvalue", not "q_value" — SchemaReflector.ToSnakeCase only inserts an underscore before an
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
}
