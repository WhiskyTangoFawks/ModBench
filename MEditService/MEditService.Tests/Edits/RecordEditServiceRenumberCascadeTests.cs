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
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Edits;

/// <summary>The renumber cascade computes every affected record's new content before it writes
/// anything; a computation failure is a typed refusal with the tree untouched.</summary>
public sealed class RecordEditServiceRenumberCascadeTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void RenumberRecord_Refuses_WhenAReferencersOnlyLinkIsAStructListScriptProperty_NamingIt()
    {
        using var fixture = CascadeFixture.WithStructListReferencer();
        var referencerFile = fixture.SourceFileOf(fixture.Referencer, "npc_", "StructListNpc");
        var referencerBefore = File.ReadAllText(referencerFile);

        var result = ServiceFor(fixture.Mirror).RenumberRecord(fixture.Plugin, fixture.Target.ToString());

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.ReferenceRemapIncomplete, result.Refusal);
        Assert.Contains(fixture.Referencer.ToString(), result.Message, StringComparison.Ordinal);

        // Refused before any write, on both sides of the cascade.
        Assert.Equal(referencerBefore, File.ReadAllText(referencerFile));
        Assert.True(File.Exists(fixture.SourceFileOf(fixture.Target, "race", "CascadeTargetRace")));
        Assert.NotNull(fixture.Mirror.Index!.At(RecordRef.Effective)
            .GetDocument(fixture.Target.ToString(), fixture.Plugin));
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenTheTargetsOwnSelfLinkIsAStructListScriptProperty()
    {
        using var fixture = CascadeFixture.WithStructListSelfReferencingTarget();
        var targetFile = fixture.SourceFileOf(fixture.Target, "npc_", "SelfStructListNpc");
        var before = File.ReadAllText(targetFile);

        var result = ServiceFor(fixture.Mirror).RenumberRecord(fixture.Plugin, fixture.Target.ToString());

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.ReferenceRemapIncomplete, result.Refusal);
        Assert.Contains(fixture.Target.ToString(), result.Message, StringComparison.Ordinal);
        Assert.Equal(before, File.ReadAllText(targetFile));
    }

    [Fact]
    public void RenumberRecord_LeavesAnIncidentalFormKeyInAStringField_Alone()
    {
        using var fixture = CascadeFixture.WithSelfReferencingTarget();
        var oldFormKey = fixture.Target.ToString();

        var result = ServiceFor(fixture.Mirror).RenumberRecord(fixture.Plugin, oldFormKey);

        Assert.True(result.Applied, result.Message);
        var moved = fixture.Mirror.Index!.At(RecordRef.Effective)
            .GetDocument(result.NewFormKey!, fixture.Plugin)!;

        // The Name field says the old FormKey and always did — it is text, not a link, and nothing
        // in this gesture has any business touching it.
        Assert.Contains($"\"{oldFormKey}\"", moved.Body!, StringComparison.Ordinal);
        // The self-link, by contrast, moved: it is the only *link* the record holds.
        Assert.Contains(
            fixture.Mirror.Index!.At(RecordRef.Effective).GetReferencedBy(result.NewFormKey!),
            r => r.FormKey == result.NewFormKey);
        Assert.Empty(fixture.Mirror.Index!.At(RecordRef.Effective).GetReferencedBy(oldFormKey));
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenAReferencersSourceUnitHasGoneFromTheTree_AndWritesNothing()
    {
        using var fixture = CascadeFixture.WithFlatAndWorldspaceReferencers();
        var targetFile = fixture.SourceFileOf(fixture.Target, "watr", "CascadeTargetWater");
        var survivingFile = fixture.SourceFileOf(fixture.Referencer, "acti", "FirstActivator");
        var survivingBefore = File.ReadAllText(survivingFile);

        // A Worldspace is a directory-per-record container with no containment parent, so removing its
        // directory is the one shape that leaves SourceUnitResolver nothing to answer: a flat record
        // always resolves to its computed path, present or not.
        Directory.Delete(fixture.DirectoryOf(fixture.SecondReferencer), recursive: true);

        var result = ServiceFor(fixture.Mirror).RenumberRecord(fixture.Plugin, fixture.Target.ToString());

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, result.Refusal);
        Assert.Contains(fixture.SecondReferencer.ToString(), result.Message, StringComparison.Ordinal);

        // The referencer whose unit *is* intact was resolvable first and is untouched: the whole
        // cascade is computed before the first byte lands, so an unresolvable one later in the list
        // cannot arrive after an earlier one has already been rewritten.
        Assert.Equal(survivingBefore, File.ReadAllText(survivingFile));
        Assert.True(File.Exists(targetFile));
    }

    // Single plugin deliberately: the cross-repo question belongs to RecordEditServiceRenumberRecordTests.
    private sealed class CascadeFixture : IDisposable
    {
        private const string PluginName = "Cascade.esp";
        private const string Origin = "CascadeMod";

        public string ModFolder { get; }
        public string GameDirectory { get; }
        public LoadOrderMirror Mirror { get; }
        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Target { get; private set; }
        public FormKey Referencer { get; private set; }
        public FormKey SecondReferencer { get; private set; }

        private CascadeFixture(Action<Fallout4Mod, CascadeFixture> seed)
        {
            ModFolder = Directory.CreateTempSubdirectory("medit-cascade-mod-").FullName;
            GameDirectory = Directory.CreateTempSubdirectory("medit-cascade-game-").FullName;

            var pluginPath = Path.Combine(ModFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            seed(mod, this);
            mod.WriteToBinary(pluginPath);

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(
                GameDirectory,
                [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(Mirror.LoadOrder!, Origin, SourcePreset.Edits).GetAwaiter().GetResult();
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
            SourceUnitResolver.FlatSourcePath(
                ModFolder, PluginName, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

        public string DirectoryOf(FormKey formKey) =>
            Directory.EnumerateDirectories(
                ModFolder, $"*{formKey.ID:X6}_{formKey.ModKey.FileName}", SearchOption.AllDirectories).Single();

        public void Dispose()
        {
            Mirror.Dispose();
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
}
