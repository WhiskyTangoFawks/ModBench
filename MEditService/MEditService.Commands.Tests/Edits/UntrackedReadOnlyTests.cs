using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>The friction is deliberate (ADR-0007), which is why the refusal must name the way
/// out.</summary>
public sealed class UntrackedReadOnlyTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingAPluginInAnUntrackedModFolder_IsRefused_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();
        Assert.False(SourceRepository.IsTracked(mod.ModFolder)); // the whole of "untracked": no .git

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));

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
        using var mod = SourceEditFixture.Untracked();

        var result = mod.EditHandler.Set(mod.Plugin, $"ABCDEF:{SourceEditFixture.PluginName}", "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
    }

    [Fact]
    public void EditingAPluginInAnUntrackedModFolder_WritesNothingAtAll()
    {
        using var mod = SourceEditFixture.Untracked();

        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));

        // Not merely "no dirt" — there is no repo to have dirt in. Hard read-only means the refusal
        // did not quietly create the source tree on its way out.
        Assert.False(Directory.Exists(Path.Combine(mod.ModFolder, SourceRepository.RootFor(SourceEditFixture.PluginName))));
        Assert.False(File.Exists(mod.NpcSourceFile));
    }

    [Fact]
    public void EditingAPluginWithNoModFolder_IsRefused_NamingThePatchPluginPathInstead()
    {
        using var vanilla = SourceModFixture.VanillaMaster(out var vanillaNpc);

        var result = vanilla.EditHandler
            .Set(vanilla.Plugin, vanillaNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginHasNoModFolder, result.Refusal);
        Assert.Contains("patch", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheTwoRefusalsAreDistinct_AndNeitherMessageOffersTheOthersWayOut()
    {
        using var untracked = SourceEditFixture.Untracked();
        using var vanilla = SourceModFixture.VanillaMaster(out var vanillaNpc);

        var trackable = untracked.EditHandler
            .Set(untracked.Plugin, untracked.Npc.ToString(), "HeightMax", Json("0.75"));
        var notTrackable = vanilla.EditHandler
            .Set(vanilla.Plugin, vanillaNpc.ToString(), "HeightMax", Json("0.75"));

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
        using var mod = SourceEditFixture.Tracked();

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.None, result.Refusal);
    }
}
