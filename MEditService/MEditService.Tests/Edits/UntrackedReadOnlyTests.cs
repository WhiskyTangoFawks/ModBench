using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #415 AC4 (backend half) and AC5's refusal: an untracked plugin is <b>hard</b> read-only, and the
/// refusal names the way out. The friction is deliberate (ADR-0041 — in-place editing of someone
/// else's plugin is the community's own anti-pattern), which is exactly why it must never be silent:
/// a refusal that does not say what to do next is the dead UI this ticket exists to remove.
///
/// <para>Two different refusals, because there are two different ways out. A plugin in a mod folder
/// is one Track away from editable. A vanilla or DLC master resolved from the game's own Data
/// directory has no mod folder to track at all, so its answer is the blessed path instead: author a
/// patch plugin.</para>
/// </summary>
public sealed class UntrackedReadOnlyTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static RecordEditService ServiceFor(ISessionManager sessions) =>
        new(sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void EditingAPluginInAnUntrackedModFolder_IsRefused_NamingTheTrackCommand()
    {
        using var mod = TrackedModFixture.Untracked();
        Assert.False(LedgerRepository.IsTracked(mod.ModFolder)); // the whole of "untracked": no .git

        var result = ServiceFor(mod.Sessions).EditField(mod.Plugin, mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Track", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAPluginInAnUntrackedModFolder_WritesNothingAtAll()
    {
        using var mod = TrackedModFixture.Untracked();

        ServiceFor(mod.Sessions).EditField(mod.Plugin, mod.Npc.ToString(), "height_max", Json("0.75"));

        // Not merely "no dirt" — there is no repo to have dirt in. Hard read-only means the refusal
        // did not quietly create the ledger tree on its way out.
        Assert.False(Directory.Exists(Path.Combine(mod.ModFolder, $"{TrackedModFixture.PluginName}.ledger")));
        Assert.False(File.Exists(mod.NpcLedgerFile));
    }

    [Fact]
    public void EditingAPluginWithNoModFolder_IsRefused_NamingThePatchPluginPathInstead()
    {
        using var vanilla = new DataDirectoryFixture();

        var result = ServiceFor(vanilla.Sessions)
            .EditField(vanilla.Plugin, vanilla.Npc.ToString(), "height_max", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginHasNoModFolder, result.Refusal);
        Assert.Contains("patch", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheTwoRefusalsAreDistinct_AndNeitherMessageOffersTheOthersWayOut()
    {
        using var untracked = TrackedModFixture.Untracked();
        using var vanilla = new DataDirectoryFixture();

        var trackable = ServiceFor(untracked.Sessions)
            .EditField(untracked.Plugin, untracked.Npc.ToString(), "height_max", Json("0.75"));
        var notTrackable = ServiceFor(vanilla.Sessions)
            .EditField(vanilla.Plugin, vanilla.Npc.ToString(), "height_max", Json("0.75"));

        // Collapsing these into one "read-only" refusal would leave half the users following advice
        // that cannot work for them — Track does not apply to a Data-directory master, and authoring
        // a patch is not the answer for a mod folder that merely has not been tracked yet.
        Assert.NotEqual(trackable.Refusal, notTrackable.Refusal);
        Assert.DoesNotContain("patch", trackable.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Track", notTrackable.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TrackingTheSameModFolder_TurnsTheRefusalIntoAnAcceptedEdit()
    {
        // The positive control for every refusal above, and the product claim AC4 makes: the escape
        // is one command, once, per mod. Same plugin, same record, same field — only .git differs.
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Sessions).EditField(mod.Plugin, mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.None, result.Refusal);
    }

    /// <summary>
    /// A plugin resolved straight from the game's Data directory — vanilla, DLC or Creation Club
    /// (<see cref="PluginOrigin.DataDirectory"/>). Its folder is the game's own, which is never a
    /// repo and must never become one, so this is a distinct state from "a mod folder nobody has
    /// tracked", not a special case of it.
    /// </summary>
    private sealed class DataDirectoryFixture : IDisposable
    {
        private const string Name = "Vanilla.esm";

        public string GameDirectory { get; }
        public SessionManager Sessions { get; }
        public PluginKey Plugin { get; } = new(Name, PluginOrigin.DataDirectory);
        public FormKey Npc { get; }

        public DataDirectoryFixture()
        {
            GameDirectory = Directory.CreateTempSubdirectory("medit-vanilla-").FullName;
            var pluginPath = Path.Combine(GameDirectory, Name);
            var mod = new Fallout4Mod(ModKey.FromFileName(Name), Fallout4Release.Fallout4);
            Npc = mod.Npcs.AddNew("VanillaNpc").FormKey;
            mod.WriteToBinary(pluginPath);

            Sessions = new SessionManager(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ISessionManager)Sessions).LoadExplicit(
                GameDirectory,
                [new ExplicitPluginInput(Name, pluginPath, PluginOrigin.DataDirectory, true)],
                GameRelease.Fallout4);
        }

        public void Dispose()
        {
            Sessions.Dispose();
            try { Directory.Delete(GameDirectory, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
        }
    }
}
