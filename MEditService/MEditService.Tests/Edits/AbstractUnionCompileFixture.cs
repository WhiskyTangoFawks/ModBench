using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// One real mod folder, tracked once, holding one record of every #611 owning type plus a small
/// supporting cast of FormLink targets — the same "one shared small mod, many facts" shape
/// <see cref="TrackedModFixture"/> already established, extended to nine subject records instead of
/// three because every one of #611's byproduct types needs its own from-scratch construction (none
/// has a reusable fixture — verified by search before this file was written) and building nine
/// separate <see cref="LoadOrderMirror"/>/<see cref="TrackService"/> setups would be the expensive
/// thing, not the records themselves.
///
/// <para>Every FormLink a leaf carries points at a real, correctly typed record in this same mod —
/// ADR-0041's Dangling/Type-Mismatched refusal (<c>RecordEditService.ValidateFormLinks</c>) would
/// otherwise refuse an edit for a reason unrelated to what a given fact is testing, the same
/// precaution <c>ComplexFieldElementEditTests.FactionsStructArray...</c> already takes.</para>
/// </summary>
public sealed class AbstractUnionCompileFixture : IDisposable
{
    public const string PluginName = "AbstractUnion611.esp";
    private const string Origin = "AbstractUnion611Mod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-611-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-611-game-").FullName;
    private readonly LoadOrderMirror _mirror;

    public LoadOrderMirror Mirror => _mirror;
    public string ModFolder => _modFolder;
    public PluginKey Plugin { get; } = new(PluginName, Origin);

    // ── Supporting cast — FormLink targets only, never edited directly ─────────
    public FormKey Keyword { get; }
    public FormKey Spell { get; }
    public FormKey Light { get; }
    public FormKey ActorValueInformation { get; }

    // ── #611's own nine subject records (plus Npc/Quest, #548's own mandatory two) ─
    public FormKey Npc { get; }
    public FormKey Quest { get; }
    public FormKey Book { get; }
    public FormKey ColorRecord { get; }
    public FormKey Holotape { get; }
    public FormKey SoundDescriptor { get; }
    public FormKey Perk { get; }
    public FormKey MagicEffect { get; }
    public FormKey AudioEffectChain { get; }

    public AbstractUnionCompileFixture()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var keyword = mod.Keywords.AddNew("Keyword611");
        var spell = mod.Spells.AddNew("Spell611");
        var light = mod.Lights.AddNew("Light611");
        var actorValueInformation = mod.ActorValueInformation.AddNew("ActorValueInformation611");
        Keyword = keyword.FormKey;
        Spell = spell.FormKey;
        Light = light.FormKey;
        ActorValueInformation = actorValueInformation.FormKey;

        var npc = mod.Npcs.AddNew("Npc611");
        npc.Level = new NpcLevel { Level = 5 };
        Npc = npc.FormKey;

        var quest = mod.Quests.AddNew("Quest611");
        quest.Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }];
        Quest = quest.FormKey;

        var perk = mod.Perks.AddNew("Perk611");
        var perkQuestEffect = new PerkQuestEffect { Stage = 7 };
        perkQuestEffect.Quest.SetTo(quest);
        perk.Effects.Add(perkQuestEffect);
        Perk = perk.FormKey;

        var book = mod.Books.AddNew("Book611");
        var bookSpell = new BookSpell();
        bookSpell.Spell.SetTo(spell);
        book.Teaches = bookSpell;
        Book = book.FormKey;

        var colorRecord = mod.Colors.AddNew("ColorRecord611");
        colorRecord.Data = new ColorRemappingIndex { Index = 2.5f };
        ColorRecord = colorRecord.FormKey;

        var soundDescriptor = mod.SoundDescriptors.AddNew("SoundDescriptor611");
        soundDescriptor.Data = new SoundDescriptorStandardData
        {
            PercentFrequencyShift = 1,
            PercentFrequencyVariance = 2,
            Priority = 3,
            Variance = 4,
            StaticAttenuation = 1.5f,
        };
        SoundDescriptor = soundDescriptor.FormKey;

        var holotape = mod.Holotapes.AddNew("Holotape611");
        holotape.Data = new HolotapeProgram { File = "startup.txt" };
        Holotape = holotape.FormKey;

        var magicEffect = mod.MagicEffects.AddNew("MagicEffect611");
        var lightArchetype = new MagicEffectLightArchetype();
        lightArchetype.Association.SetTo(light);
        magicEffect.Archetype = lightArchetype;
        MagicEffect = magicEffect.FormKey;

        var audioEffectChain = mod.AudioEffectChains.AddNew("AudioEffectChain611");
        audioEffectChain.Effects.Add(new OverdriveAudioEffect
        {
            Enabled = true,
            InputGain = 1f,
            OutputGain = 2f,
            UpperThreshold = 3f,
            LowerThreshold = 4f,
        });
        AudioEffectChain = audioEffectChain.FormKey;

        mod.WriteToBinary(pluginPath);

        _mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)_mirror).Reconcile(
            _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _mirror.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
