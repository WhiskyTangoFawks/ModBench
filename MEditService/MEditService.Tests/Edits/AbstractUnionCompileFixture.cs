using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>One mod tracked once, holding one record of every owning type: the expensive part is the <see
/// cref="TrackService"/> setup, not the records.</summary>
public sealed class AbstractUnionCompileFixture : IDisposable
{
    public const string PluginName = "AbstractUnion611.esp";
    private const string Origin = "AbstractUnion611Mod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-611-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-611-game-").FullName;

    public string ModFolder => _modFolder;
    public PluginKey Plugin { get; } = new(PluginName, Origin);
    public LoadOrder LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }

    // ── Supporting cast — FormLink targets only, never edited directly ─────────
    public FormKey Keyword { get; }
    public FormKey Spell { get; }
    public FormKey Light { get; }
    public FormKey ActorValueInformation { get; }

    // ── Nine subject records (plus Npc/Quest, two mandatory types) ─
    public FormKey Npc { get; }
    public FormKey Quest { get; }
    public FormKey Book { get; }
    public FormKey ColorRecord { get; }
    public FormKey Holotape { get; }
    public FormKey SoundDescriptor { get; }
    public FormKey Perk { get; }
    public FormKey MagicEffect { get; }
    public FormKey AudioEffectChain { get; }

    // ── Two nested abstract unions (ALocationTarget / ANavmeshParent), reached one
    // level inside an ordinary struct column rather than as a column of their own ─
    public FormKey Faction { get; }
    public FormKey Static { get; }

    public AbstractUnionCompileFixture()
    {
        var holder = new LoadOrderHolder();
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

        var faction = mod.Factions.AddNew("Faction611");
        faction.VendorLocation = new LocationTargetRadius
        {
            Radius = 1,
            Target = new LocationFallback { Type = LocationTargetRadius.LocationType.NearReference, Data = 0 },
        };
        Faction = faction.FormKey;

        // Minimal geometry: every list member stays its empty default, and both parent leaves'
        // FormLinks stay null — no linked Worldspace/Cell record needed.
        var stat = mod.Statics.AddNew("Static611");
        stat.NavmeshGeometry = new NavmeshGeometry { Parent = new WorldspaceNavmeshParent() };
        Static = stat.FormKey;

        mod.WriteToBinary(pluginPath);

        LoadOrder = new LoadOrder(
            _gameDirectory, _gameDirectory, GameRelease.Fallout4,
            SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));
        new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(LoadOrder, [Plugin], Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
    }

    public void Dispose()
    {
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
