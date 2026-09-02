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

/// <summary>
/// #676: the renumber cascade computes every affected record's new content before it writes
/// anything. These are the cases that distinguish that shape from the write-one-referencer-at-a-time
/// one it replaced — a computation failure arriving as a typed refusal with the tree untouched, the
/// typed remap's precision where the old whole-body text substitution over-matched, and the one
/// place the typed remap is not precise enough (upstream-mutagen-issue.md).
/// </summary>
public sealed class RecordEditServiceRenumberCascadeTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    /// <summary>
    /// The referencer's only link to the target lives in a VMAD <c>ArrayOfStruct</c> script
    /// property, which Mutagen's generated <c>ScriptStructListProperty.RemapLinks</c> does not walk
    /// (base-only — see <c>upstream-mutagen-issue.md</c>). mEdit's own reference index <i>does</i>
    /// walk it, so the record is in the cascade's list, gets loaded, and is caught by the
    /// post-serialise check rather than written with the link left pointing at the old FormKey.
    /// </summary>
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

    /// <summary>
    /// The old cascade rewrote every textual occurrence of the FormKey in the referencer's file.
    /// The renumbered record's own file went through that same substitution whenever it referenced
    /// itself, so a FormKey spelled incidentally in one of its string fields was rewritten along
    /// with the link. The typed remap moves links and only links.
    /// </summary>
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

    /// <summary>
    /// A referencer the index lists but whose source unit has gone from the tree (the
    /// never-assume-exclusive-ownership case — another tool moved or removed it since the last
    /// reconcile). A computation failure, so it lands as a typed refusal with nothing written,
    /// rather than as an exception thrown after earlier referencers had already been rewritten.
    /// </summary>
    [Fact]
    public void RenumberRecord_Refuses_WhenAReferencersSourceUnitHasGoneFromTheTree_AndWritesNothing()
    {
        using var fixture = CascadeFixture.WithFlatAndWorldspaceReferencers();
        var targetFile = fixture.SourceFileOf(fixture.Target, "watr", "CascadeTargetWater");
        var survivingFile = fixture.SourceFileOf(fixture.Referencer, "acti", "FirstActivator");
        var survivingBefore = File.ReadAllText(survivingFile);

        // A Worldspace is a directory-per-record container with no containment parent of its own, so
        // removing its directory is the one shape that genuinely leaves SourceUnitResolver with
        // nothing to answer — a flat record always resolves to its computed path, present or not.
        // The index still lists it as referencing the target.
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

    /// <summary>
    /// One tracked plugin holding a Race (the renumber target) plus whichever referencing records
    /// the case under test needs. Single-plugin deliberately: the cross-repo question is
    /// <see cref="RecordEditServiceRenumberRecordTests"/>'s, and these cases are about what the
    /// cascade computes, which is the same either way.
    /// </summary>
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

        /// <summary>An Npc whose only link to the Race is a VMAD <c>ArrayOfStruct</c> member —
        /// the shape Mutagen's generated remap does not walk.</summary>
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

        /// <summary>A Race that references itself through its own <c>MorphRace</c> FormLink, and
        /// spells its own FormKey incidentally in a string field that is not a link.</summary>
        public static CascadeFixture WithSelfReferencingTarget() => new((mod, self) =>
        {
            var race = mod.Races.AddNew("SelfReferencingRace");
            self.Target = race.FormKey;
            self.Referencer = race.FormKey;
            race.MorphRace.SetTo(race.FormKey);
            race.Name = new TranslatedString(Language.English, race.FormKey.ToString());
        });

        /// <summary>A Water referenced twice: once by a flat Activator's <c>WaterType</c>, once by a
        /// Worldspace's <c>Water</c>. The Worldspace is the interesting half — a directory-per-record
        /// container with no containment parent, so its directory going missing is the one shape that
        /// leaves <c>SourceUnitResolver.Resolve</c> with no answer at all.</summary>
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

        /// <summary>The directory a container record's own <c>RecordData.json</c> sits in, found by
        /// the FormKey in its leaf name rather than computed — the order index is the tree's to
        /// choose.</summary>
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
