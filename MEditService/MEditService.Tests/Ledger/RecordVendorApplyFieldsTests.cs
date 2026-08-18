using System.Text.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #370 review findings 2 + 3, at <see cref="RecordVendor"/>'s own public seam (narrower than the
/// API host — this is a regression test for the class's own contract, not a new product behavior
/// with an HTTP-observable shape of its own): a field that fails to apply must be surfaced, not
/// silently dropped from the vendored dirt (finding 2), and a mid-pipeline failure must never leave
/// a baseline commit with no matching dirt (finding 3) — proven together, since finding 2's fix
/// (throwing on a non-<c>Applied</c> outcome) is also what exercises finding 3's reordering.
/// </summary>
public class RecordVendorApplyFieldsTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (RecordVendor Vendor, LedgerRepository Ledger) MakeVendor(string ledgerRoot)
    {
        var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        return (new RecordVendor(ledger, codec, NullLogger<RecordVendor>.Instance), ledger);
    }

    private static string WritePlugin(string originFolder, string pluginFileName, out string npcFormKey)
    {
        var pluginPath = Path.Combine(originFolder, pluginFileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginFileName), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("VendorNpc");
        mod.WriteToBinary(pluginPath);
        npcFormKey = npc.FormKey.ToString();
        return pluginPath;
    }

    [Fact]
    public async Task FirstTouch_FieldFailsToApply_ThrowsAndLeavesNoBaselineCommit()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-vendor-apply-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-vendor-apply-origin-").FullName;
        try
        {
            var (vendor, ledger) = MakeVendor(ledgerRoot);
            const string pluginFileName = "Vendor.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var formKey);
            var fields = new Dictionary<string, JsonElement> { ["totallyBogusField"] = J("\"x\"") };

            await Assert.ThrowsAsync<VendorFieldApplyException>(() =>
                vendor.VendorAndStageDirtAsync(
                    originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), formKey,
                    fields, Schemas, GameRelease.Fallout4));

            // Finding 3: no baseline commit exists — the pristine text got staged (an inert index
            // entry) but the failure happened before CommitStaged, so IsTrackedAtHead — which
            // answers purely from HEAD — is still false. A later, valid edit can retry cleanly.
            var relativePath = GetRelativePath(pluginFileName, formKey);
            Assert.False(ledger.IsTrackedAtHead(originFolder, relativePath));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    [Fact]
    public async Task SecondTouch_FieldFailsToApply_ThrowsAndLeavesExistingDirtUntouched()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-vendor-apply-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-vendor-apply-origin-").FullName;
        try
        {
            var (vendor, ledger) = MakeVendor(ledgerRoot);
            const string pluginFileName = "Vendor.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var formKey);
            var relativePath = GetRelativePath(pluginFileName, formKey);
            var absolutePath = Path.Combine(originFolder, relativePath);

            // A genuine first touch, with a field that does apply.
            await vendor.VendorAndStageDirtAsync(
                originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), formKey,
                new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
                Schemas, GameRelease.Fallout4);
            Assert.True(ledger.IsTrackedAtHead(originFolder, relativePath));
            var dirtBeforeFailedAttempt = await File.ReadAllTextAsync(absolutePath);

            // A second edit whose field cannot apply must not corrupt the dirt the first edit left.
            await Assert.ThrowsAsync<VendorFieldApplyException>(() =>
                vendor.VendorAndStageDirtAsync(
                    originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), formKey,
                    new Dictionary<string, JsonElement> { ["totallyBogusField"] = J("\"x\"") },
                    Schemas, GameRelease.Fallout4));

            var dirtAfterFailedAttempt = await File.ReadAllTextAsync(absolutePath);
            Assert.Equal(dirtBeforeFailedAttempt, dirtAfterFailedAttempt);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // ValidateEditContext never confirms the target plugin's own binary actually contains an
    // override of the staged FormKey (only that the FormKey exists *somewhere* and that the plugin
    // itself is a legal write target) — a mismatched (plugin, formKey) pair reaches vendoring, and
    // the deep-parsed target plugin genuinely does not contain that record. Reachable with the same
    // two-plugin shape the collision test already builds, so covered here rather than deferred.
    [Fact]
    public async Task RecordAbsentFromTheTargetPluginsOwnBinary_ThrowsNamedNotFound()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-vendor-apply-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-vendor-apply-origin-").FullName;
        try
        {
            var (vendor, _) = MakeVendor(ledgerRoot);
            _ = WritePlugin(originFolder, "Other.esp", out var otherFormKey);
            var targetPluginPath = WritePlugin(originFolder, "Target.esp", out _); // its own NPC, not Other.esp's.

            var ex = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                vendor.VendorAndStageDirtAsync(
                    originFolder, targetPluginPath, "Target.esp", "npc_", typeof(Npc),
                    otherFormKey, new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
                    Schemas, GameRelease.Fallout4));

            Assert.Contains(otherFormKey, ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // #371 review finding 1 (the headline one): a stray index entry an *earlier* attempt against
    // this same origin folder left behind — its own UnstagePath never ran, e.g. because the process
    // died between StagePath and CommitStaged/UnstagePath — must not get folded into a *later*
    // vendor's baseline commit. Simulated directly (staging a second record's content without ever
    // committing or unstaging it, standing in for that dead-process window) rather than by actually
    // killing a process mid-flight, which isn't reproducible from a test.
    [Fact]
    public async Task StrayStagedEntryFromAnEarlierUnfinishedAttempt_IsNotSweptIntoTheNextVendorCommit()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-vendor-apply-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-vendor-apply-origin-").FullName;
        try
        {
            var (vendor, ledger) = MakeVendor(ledgerRoot);
            const string pluginFileName = "Vendor.esp";
            var (pluginPath, npc1FormKey, npc2FormKey) = WriteTwoNpcPlugin(originFolder, pluginFileName);

            // Simulate the dead-process window: npc2's content written and staged, but the sequence
            // that should have followed (apply fields, serialize, CommitStaged/UnstagePath) never
            // ran — exactly the state LedgerRepository.ResetIndexToHead's remarks describe.
            ledger.EnsureRepo(originFolder);
            var strayRelativePath = GetRelativePath(pluginFileName, npc2FormKey);
            var strayAbsolutePath = Path.Combine(originFolder, strayRelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(strayAbsolutePath)!);
            await File.WriteAllTextAsync(strayAbsolutePath, "FormKey: stray-never-committed\n");
            ledger.StagePath(originFolder, strayRelativePath);

            // A genuine, successful vendor call for a *different* record in the same origin folder.
            await vendor.VendorAndStageDirtAsync(
                originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), npc1FormKey,
                new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
                Schemas, GameRelease.Fallout4);

            // The stray record must not have been silently committed alongside npc1's own baseline.
            Assert.False(ledger.IsTrackedAtHead(originFolder, strayRelativePath));

            var npc1RelativePath = GetRelativePath(pluginFileName, npc1FormKey);
            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            var committedFiles = GitCli.Run(gitDir, workTree, "show", "--stat", "--format=", "HEAD").Trim();
            Assert.Equal(npc1RelativePath.Replace('\\', '/'), committedFiles.Split('|')[0].Trim());

            // No data loss either: the stray file is still on disk, just correctly unstaged/untracked.
            Assert.True(File.Exists(strayAbsolutePath));
            var status = GitCli.Run(gitDir, workTree, "status", "--porcelain");
            Assert.Contains(strayRelativePath.Replace('\\', '/'), status, StringComparison.Ordinal);
            Assert.StartsWith("??", status.Split('\n').Single(l => l.Contains(strayRelativePath.Replace('\\', '/'), StringComparison.Ordinal)), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    private static (string PluginPath, string Npc1FormKey, string Npc2FormKey) WriteTwoNpcPlugin(
        string originFolder, string pluginFileName)
    {
        var pluginPath = Path.Combine(originFolder, pluginFileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginFileName), Fallout4Release.Fallout4);
        var npc1 = mod.Npcs.AddNew("VendorNpc1");
        var npc2 = mod.Npcs.AddNew("VendorNpc2");
        mod.WriteToBinary(pluginPath);
        return (pluginPath, npc1.FormKey.ToString(), npc2.FormKey.ToString());
    }

    // Mirrors LedgerRecordPath.For's own (internal) policy without depending on it directly, so this
    // test still tells us something if that policy ever changes shape — it's asserting on
    // IsTrackedAtHead's outcome for *a* path this vendoring call is known to have used, not on the
    // path-construction logic itself (that's LedgerRecordPathTests' job).
    private static string GetRelativePath(string pluginFileName, string formKeyString) =>
        LedgerRecordPath.For(pluginFileName, "npc_", formKeyString);
}
