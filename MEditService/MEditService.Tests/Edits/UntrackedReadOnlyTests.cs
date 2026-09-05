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

namespace MEditService.Tests.Edits;

/// <summary>The friction is deliberate (ADR-0041), which is why the refusal must name the way
/// out.</summary>
public sealed class UntrackedReadOnlyTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void EditingAPluginInAnUntrackedModFolder_IsRefused_NamingTheTrackCommand()
    {
        using var mod = TrackedModFixture.Untracked();
        Assert.False(SourceRepository.IsTracked(mod.ModFolder)); // the whole of "untracked": no .git

        var result = ServiceFor(mod.Mirror).EditField(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        // The exact palette entry: a signpost naming a command that does not exist verbatim is the dead
        // end this refusal prevents. Asserted against the literal so the test disagrees with a bad rename
        // instead of moving with it.
        Assert.Contains("Modbench: Track\u2026", result.Message, StringComparison.Ordinal);
    }

    // ResolveEditTarget's step order: the write-path gate must fire before the existence check, or an
    // untracked plugin reports RecordNotFound and sends the user chasing a FormKey typo when the real
    // problem is that the whole plugin is read-only.
    [Fact]
    public void EditingANonexistentFormKey_OnAnUntrackedPlugin_StillRefusesAsUntracked_NotAsRecordNotFound()
    {
        using var mod = TrackedModFixture.Untracked();

        var result = ServiceFor(mod.Mirror).EditField(mod.Plugin, $"ABCDEF:{TrackedModFixture.PluginName}", "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
    }

    [Fact]
    public void EditingAPluginInAnUntrackedModFolder_WritesNothingAtAll()
    {
        using var mod = TrackedModFixture.Untracked();

        ServiceFor(mod.Mirror).EditField(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));

        // Not merely "no dirt" — there is no repo to have dirt in. Hard read-only means the refusal
        // did not quietly create the source tree on its way out.
        Assert.False(Directory.Exists(Path.Combine(mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName))));
        Assert.False(File.Exists(mod.NpcSourceFile));
    }

    [Fact]
    public void EditingAPluginWithNoModFolder_IsRefused_NamingThePatchPluginPathInstead()
    {
        using var vanilla = new DataDirectoryFixture();

        var result = ServiceFor(vanilla.Mirror)
            .EditField(vanilla.Plugin, vanilla.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginHasNoModFolder, result.Refusal);
        Assert.Contains("patch", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheTwoRefusalsAreDistinct_AndNeitherMessageOffersTheOthersWayOut()
    {
        using var untracked = TrackedModFixture.Untracked();
        using var vanilla = new DataDirectoryFixture();

        var trackable = ServiceFor(untracked.Mirror)
            .EditField(untracked.Plugin, untracked.Npc.ToString(), "HeightMax", Json("0.75"));
        var notTrackable = ServiceFor(vanilla.Mirror)
            .EditField(vanilla.Plugin, vanilla.Npc.ToString(), "HeightMax", Json("0.75"));

        // Collapsing these into one refusal would leave half the users following advice that cannot work:
        // Track does not apply to a Data-directory master, and authoring a patch is not the answer for an
        // untracked mod folder.
        Assert.NotEqual(trackable.Refusal, notTrackable.Refusal);
        Assert.DoesNotContain("patch", trackable.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Track", notTrackable.Message, StringComparison.Ordinal);
        Assert.Contains("Modbench: Track\u2026", trackable.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TrackingTheSameModFolder_TurnsTheRefusalIntoAnAcceptedEdit()
    {
        // The positive control for every refusal above, and the product claim: the escape
        // is one command, once, per mod. Same plugin, same record, same field — only .git differs.
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).EditField(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.None, result.Refusal);
    }

    // The game's own Data folder is never a repo and must never become one: a distinct state from
    // "untracked mod folder", not a special case of it.
    private sealed class DataDirectoryFixture : IDisposable
    {
        private const string Name = "Vanilla.esm";

        public string GameDirectory { get; }
        public LoadOrderMirror Mirror { get; }
        public PluginKey Plugin { get; } = new(Name, PluginOrigin.DataDirectory);
        public FormKey Npc { get; }

        public DataDirectoryFixture()
        {
            GameDirectory = Directory.CreateTempSubdirectory("medit-vanilla-").FullName;
            var pluginPath = Path.Combine(GameDirectory, Name);
            var mod = new Fallout4Mod(ModKey.FromFileName(Name), Fallout4Release.Fallout4);
            Npc = mod.Npcs.AddNew("VanillaNpc").FormKey;
            mod.WriteToBinary(pluginPath);

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(
                GameDirectory,
                [new LoadOrderEntry(Name, pluginPath, PluginOrigin.DataDirectory, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
        }

        public void Dispose()
        {
            Mirror.Dispose();
            try { Directory.Delete(GameDirectory, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
        }
    }
}
