using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Edits;

/// <summary>One tracked plugin seeded per case, since the cross-repo question belongs to
/// <see cref="RenumberTwoModFixture"/>. No index anywhere in it.</summary>
public sealed class CascadeFixture : IDisposable
{
    public const string PluginName = "Cascade.esp";
    public const string Origin = "CascadeMod";

    public string ModFolder { get; }
    public string GameDirectory { get; }

    /// <summary>The same snapshot as a list, for a test reconciling an index over this tree.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries { get; }

    public LoadOrder LoadOrder { get; }
    public RenumberRecordHandler RenumberHandler { get; }
    public PluginKey Plugin { get; } = new(PluginName, Origin);
    public FormKey Target { get; private set; }
    public FormKey Referencer { get; private set; }
    public FormKey SecondReferencer { get; private set; }

    private CascadeFixture(Action<Fallout4Mod, CascadeFixture> seed)
    {
        var holder = new LoadOrderHolder();
        ModFolder = Directory.CreateTempSubdirectory("medit-cascade-mod-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-cascade-game-").FullName;

        var pluginPath = Path.Combine(ModFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        seed(mod, this);
        mod.WriteToBinary(pluginPath);

        Entries = [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)];
        LoadOrder = new LoadOrder(GameDirectory, GameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(Entries));

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(LoadOrder, [Plugin], Origin, SourcePreset.Edits).GetAwaiter().GetResult();

        holder.Apply(LoadOrder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
    }

    public static CascadeFixture WithStructListReferencer() => new((mod, self) =>
    {
        var race = mod.Races.AddNew("CascadeTargetRace");
        self.Target = race.FormKey;

        var npc = mod.Npcs.AddNew("StructListNpc");
        self.Referencer = npc.FormKey;

        var member = new ScriptObjectProperty { Name = "Target", Alias = -1 };
        member.Object.SetTo(race.FormKey);
        var instance = new ScriptEntryStructs();
        instance.Members.Add(member);
        var structList = new ScriptStructListProperty { Name = "Slots" };
        structList.Structs.Add(instance);

        var script = new ScriptEntry { Name = "CascadeScript", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(structList);
        var vmad = new VirtualMachineAdapter();
        vmad.Scripts.Add(script);
        npc.VirtualMachineAdapter = vmad;
    });

    public static CascadeFixture WithStructListSelfReferencingTarget() => new((mod, self) =>
    {
        var npc = mod.Npcs.AddNew("SelfStructListNpc");
        self.Target = npc.FormKey;
        self.Referencer = npc.FormKey;

        var member = new ScriptObjectProperty { Name = "Self", Alias = -1 };
        member.Object.SetTo(npc.FormKey);
        var instance = new ScriptEntryStructs();
        instance.Members.Add(member);
        var structList = new ScriptStructListProperty { Name = "Slots" };
        structList.Structs.Add(instance);

        var script = new ScriptEntry { Name = "CascadeScript", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(structList);
        var vmad = new VirtualMachineAdapter();
        vmad.Scripts.Add(script);
        npc.VirtualMachineAdapter = vmad;
    });

    public static CascadeFixture WithSelfReferencingTarget() => new((mod, self) =>
    {
        var race = mod.Races.AddNew("SelfReferencingRace");
        self.Target = race.FormKey;
        self.Referencer = race.FormKey;
        race.MorphRace.SetTo(race.FormKey);
        race.Name = new TranslatedString(Language.English, race.FormKey.ToString());
    });

    /// <summary>OMOD is FO4's path-ambiguous group: five concrete classes under one signature, so the
    /// document names its own class rather than the schema's table.</summary>
    public static CascadeFixture WithPathAmbiguousGroupReferencer() => new((mod, self) =>
    {
        var looseMod = mod.MiscItems.AddNew("CascadeTargetMisc");
        self.Target = looseMod.FormKey;

        var armorMod = new ArmorModification(mod.GetNextFormKey("CascadeArmorMod"), Fallout4Release.Fallout4)
        {
            EditorID = "CascadeArmorMod",
        };
        armorMod.LooseMod.SetTo(looseMod);
        mod.ObjectModifications.Add(armorMod);
        self.Referencer = armorMod.FormKey;
    });

    public static CascadeFixture WithFlatAndWorldspaceReferencers() => new((mod, self) =>
    {
        var water = mod.Waters.AddNew("CascadeTargetWater");
        self.Target = water.FormKey;

        var first = mod.Activators.AddNew("FirstActivator");
        first.WaterType.SetTo(water.FormKey);
        self.Referencer = first.FormKey;

        var worldspace = new Worldspace(mod) { EditorID = "CascadeWorld" };
        worldspace.Water.SetTo(water.FormKey);
        mod.Worldspaces.Add(worldspace);
        self.SecondReferencer = worldspace.FormKey;
    });

    public string SourceFileOf(FormKey formKey, string recordType, string editorId) =>
        SourceDocumentPath.Of(ModFolder, PluginName, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

    public string DirectoryOf(FormKey formKey) =>
        Directory.EnumerateDirectories(
            ModFolder, $"*{formKey.ID:X6}_{formKey.ModKey.FileName}", SearchOption.AllDirectories).Single();

    /// <summary>What the tree holds for a FormKey — the whole read model here.</summary>
    public SourceDocument? Document(string formKey) => TrackedTree.Document(ModFolder, Plugin, formKey);

    public void Dispose()
    {
        TryDelete(ModFolder);
        TryDelete(GameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
