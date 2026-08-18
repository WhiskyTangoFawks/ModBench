using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Api;

/// <summary>
/// #371 slice 1/2/3/4: commit = save. Driven end to end through the real stage (<c>PATCH
/// /records/{formKey}</c>) and save (<c>POST /change-groups/{id}/save</c>) endpoints against a
/// scattered, per-origin-folder fixture, observed through the real git CLI — same seam and fixture
/// style as <see cref="VendorOnFirstTouchApiTests"/>.
/// </summary>
public class SaveChangeGroupLedgerCommitApiTests
{
    private static ScatteredFixtureData BuildOneNpcFixture(out string npcFormKey)
    {
        Mutagen.Bethesda.Plugins.FormKey fk = default;
        var fx = new PluginFixtureBuilder("save-ledger-commit")
            .WithPlugin("SaveTarget.esp", mod => fk = mod.Npcs.AddNew("SaveTargetNpc").FormKey, origin: "SaveMod")
            .BuildScattered();
        npcFormKey = fk.ToString();
        return fx;
    }

    private static async Task LoadAsync(HttpClient client, ScatteredFixtureData fx)
    {
        var load = await client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            plugins = fx.Plugins.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = true }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private static async Task PatchAsync(HttpClient client, string formKey, string plugin, string field, object value)
    {
        var resp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(formKey)}", new
        {
            plugin,
            fields = new Dictionary<string, object?> { [field] = value },
            source = "user",
        });
        resp.EnsureSuccessStatusCode();
    }

    private static async Task<string> SingleGroupIdAsync(HttpClient client)
    {
        var groups = await client.GetFromJsonAsync<JsonElement[]>("/change-groups");
        return Assert.Single(groups!).GetProperty("id").GetString()!;
    }

    private static LedgerRepository LedgerFor(string ledgerRoot) =>
        new(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);

    // AC1.
    [Fact]
    public async Task SaveChangeGroup_AfterFieldEditOnATrackedRecord_ProducesExactlyOneNewCommit_BinaryAndBackupUnchanged()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneNpcFixture(out var npcFormKey);
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFormKey, "SaveTarget.esp", "aggression", "Frenzied");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "SaveMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var relativePath = LedgerRecordPath.For("SaveTarget.esp", "npc_", npcFormKey).Replace('\\', '/');

        // Before save: one commit (the vendor baseline), one uncommitted dirt file.
        var beforeLog = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        Assert.Single(beforeLog.Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.NotEmpty(GitCli.Run(gitDir, workTree, "status", "--porcelain"));

        var groupId = await SingleGroupIdAsync(client);
        var saveResp = await client.PostAsync($"/change-groups/{groupId}/save", null);
        saveResp.EnsureSuccessStatusCode();

        // AC1: exactly one *new* commit landed — two total (vendor baseline + this save).
        var afterLog = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        Assert.Equal(2, afterLog.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);

        // AC1: the new commit's own tree contains exactly the group's touched record file, and the
        // ledger-tracked file itself is clean again (dirt got committed, nothing left over) — the
        // save's own binary write also drops a fresh timestamped `.bak` (ADR-0008) right beside the
        // plugin, inside this same origin folder (the ledger's own working tree), which is untracked
        // ("??") and expected: proof that binary write behaviour is unchanged, not ledger leftovers.
        var statusAfterSave = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        Assert.DoesNotContain(relativePath, statusAfterSave, StringComparison.Ordinal);
        Assert.All(statusAfterSave.Split('\n', StringSplitOptions.RemoveEmptyEntries), line => Assert.StartsWith("??", line, StringComparison.Ordinal));
        var committedFiles = GitCli.Run(gitDir, workTree, "show", "--stat", "--format=", "HEAD").Trim();
        Assert.Equal(relativePath, committedFiles.Split('|')[0].Trim());

        // AC1/ADR-0040: the commit message carries the group's intent, not a generic label.
        var message = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%s", "main");
        Assert.Contains("npc_", message, StringComparison.Ordinal);
        Assert.Contains(npcFormKey, message, StringComparison.Ordinal);

        // AC1: binary write + .bak (ADR-0008) unchanged — same response shape SaveChangeGroupApiTests
        // already asserts on a flat (non-scattered) fixture.
        var body = JsonSerializer.Deserialize<JsonElement>(await saveResp.Content.ReadAsStringAsync());
        var columnKey = ColumnKey.Of("SaveTarget.esp", "SaveMod");
        var backupPath = body.GetProperty("byPlugin").GetProperty(columnKey).GetProperty("backupPath").GetString();
        Assert.NotNull(backupPath);
        Assert.True(File.Exists(backupPath));
    }

    // AC2. ImmutablePlugin refusal is unreachable here with real staged dirt present — StageEdit's
    // own immutable guard already refuses at PATCH time (ValidateEditContext), before anything can
    // vendor — so the representative "a Save call that does not reach the Saved branch must never
    // touch the ledger" case reachable through the real API is an unresolvable/already-consumed
    // group id (404/NoChanges), proven here with real dirt already sitting in the ledger from a
    // prior successful PATCH, so there is something a wrongly-early commit *could* have swept in.
    [Fact]
    public async Task SaveChangeGroup_UnknownGroupId_LeavesTheLedgerUnadvanced()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneNpcFixture(out var npcFormKey);
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFormKey, "SaveTarget.esp", "aggression", "Frenzied");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "SaveMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var beforeLog = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        var beforeStatus = GitCli.Run(gitDir, workTree, "status", "--porcelain");

        // A group id that names no staged change at all — the NoChanges refusal path, which never
        // reaches ExecuteGroupSaveAsync's Saved branch and so must never reach the ledger either.
        var saveResp = await client.PostAsync($"/change-groups/{Guid.NewGuid()}/save", null);
        Assert.Equal(System.Net.HttpStatusCode.NotFound, saveResp.StatusCode);

        var afterLog = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        var afterStatus = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        Assert.Equal(beforeLog, afterLog);
        Assert.Equal(beforeStatus, afterStatus);
    }

    // AC4.
    [Fact]
    public async Task History_AfterTwoSaveCycles_ListsCommitsWithWellFormedMessagesAndTimestamps()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneNpcFixture(out var npcFormKey);
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFormKey, "SaveTarget.esp", "aggression", "Frenzied");
        var groupId1 = await SingleGroupIdAsync(client);
        (await client.PostAsync($"/change-groups/{groupId1}/save", null)).EnsureSuccessStatusCode();

        await PatchAsync(client, npcFormKey, "SaveTarget.esp", "confidence", "Foolhardy");
        var groupId2 = await SingleGroupIdAsync(client);
        (await client.PostAsync($"/change-groups/{groupId2}/save", null)).EnsureSuccessStatusCode();

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "SaveMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);

        // Vendor baseline + two save commits.
        var log = GitCli.Run(gitDir, workTree, "log", "--format=%s%x1f%ct", "main");
        var entries = log.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Split('\x1f'))
            .ToList();
        Assert.Equal(3, entries.Count);
        Assert.All(entries, e =>
        {
            Assert.False(string.IsNullOrWhiteSpace(e[0])); // message
            Assert.True(long.Parse(e[1], System.Globalization.CultureInfo.InvariantCulture) > 0); // unix timestamp
        });
        Assert.Contains(entries, e => e[0].StartsWith("vendor:", StringComparison.Ordinal));
        Assert.Equal(2, entries.Count(e => e[0].StartsWith("save:", StringComparison.Ordinal)));
    }

    // AC2/#389: a VMAD struct-op edit now vendors on first touch (EditOrchestrator.
    // StageVmadStructOps), so a group whose only touched record was staged as a struct op is no
    // longer ledger-untracked — the save commits the already-staged dirt (LedgerGroupCommitter's
    // generic TryStageFieldEdit branch, unmodified by #389) exactly like an ordinary field edit
    // would, and what lands in the ledger's committed text must match what the save actually wrote
    // to the binary for the same edit, not merely "some commit landed".
    [Fact]
    public async Task SaveChangeGroup_TouchingAVmadStructOpEdit_CommitsLedgerTextMatchingTheSavedBinary()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneNpcFixture(out var npcFormKey);
        await LoadAsync(client, fx);

        var structOpResp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(npcFormKey)}", new
        {
            plugin = "SaveTarget.esp",
            fields = new Dictionary<string, object?>
            {
                [@"VMAD\SomeScript"] = new { op = "add_script", name = "SomeScript", flags = "Local", properties = Array.Empty<object>() },
            },
            source = "user",
            changeType = "vmad_struct_op",
        });
        structOpResp.EnsureSuccessStatusCode();

        var pluginPath = fx.Plugins.Single(p => p.Origin == "SaveMod").Path;
        var originFolder = Path.GetDirectoryName(pluginPath)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var relativePath = LedgerRecordPath.For("SaveTarget.esp", "npc_", npcFormKey).Replace('\\', '/');

        // Vendored at stage time: repo exists, baseline committed, no script in it yet.
        Assert.True(Directory.Exists(gitDir));
        var pristine = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath}");
        Assert.DoesNotContain("SomeScript", pristine, StringComparison.Ordinal);

        var groupId = await SingleGroupIdAsync(client);
        var saveResp = await client.PostAsync($"/change-groups/{groupId}/save", null);
        saveResp.EnsureSuccessStatusCode();

        // The save produced a new commit — the struct-op's dirt, generically staged and committed by
        // LedgerGroupCommitter the same way an ordinary field edit's dirt would be.
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        Assert.Equal(2, log.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
        var committed = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath}");
        Assert.Contains("SomeScript", committed, StringComparison.Ordinal);

        // AC2, two-sided: what the ledger committed must *equal* what the save actually wrote to the
        // binary, not merely both happen to mention the script name. A fresh deep-parse of the saved
        // plugin — an entirely independent read of the real binary bytes on disk, not the in-memory
        // record RecordVendor already had staged — run back through the very same RecordTextCodec the
        // ledger itself uses must reproduce the committed text byte-for-byte; a script vendored with
        // wrong flags, wrong/extra properties, or misapplied via the wrong ChangeType (this ticket's
        // own bug class) would diverge here even though both blobs still mention "SomeScript".
        var modPath = new ModPath(ModKey.FromFileName("SaveTarget.esp"), pluginPath);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        var npc = mod.Npcs.First(n => n.FormKey.ToString() == npcFormKey);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var reparsedPath = Path.Combine(Path.GetTempPath(), $"medit-vmad-reparsed-{Guid.NewGuid()}.yaml");
        try
        {
            await codec.SerializeAsync(npc, reparsedPath, GameRelease.Fallout4);
            var reparsedText = await File.ReadAllTextAsync(reparsedPath);
            Assert.Equal(committed, reparsedText);
        }
        finally
        {
            File.Delete(reparsedPath);
        }
    }
}
