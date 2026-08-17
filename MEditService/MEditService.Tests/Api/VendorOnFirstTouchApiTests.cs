using System.Net.Http.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// #370 Slice A2/B/C/Q3/H: the ledger's own git repo, observed through the real git CLI (never
/// mocked) — driven end-to-end through the real stage endpoint (<c>PATCH /records/{formKey}</c>)
/// against a scattered, per-mod-folder fixture (<see cref="PluginFixtureBuilder.BuildScattered"/>),
/// matching how a real MO2-style install actually looks (one mod folder per plugin, unlike the flat
/// single-folder <see cref="TestPluginFixture"/> most other API tests use).
/// </summary>
public class VendorOnFirstTouchApiTests
{
    private static ScatteredFixtureData BuildOneMod(out string npc1, out string npc2) =>
        BuildOneModCore(out npc1, out npc2);

    // Two NPCs per mod: the second FormKey backs Slice B (a different record in the same mod).
    private static ScatteredFixtureData BuildOneModCore(out string npc1FormKey, out string npc2FormKey)
    {
        Mutagen.Bethesda.Plugins.FormKey f1 = default, f2 = default;
        var fx = new PluginFixtureBuilder("vendor-on-first-touch")
            .WithPlugin("Vendor.esp", mod =>
            {
                f1 = mod.Npcs.AddNew("VendorNpc1").FormKey;
                f2 = mod.Npcs.AddNew("VendorNpc2").FormKey;
            }, origin: "VendorMod")
            .BuildScattered();
        npc1FormKey = f1.ToString();
        npc2FormKey = f2.ToString();
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

    private static async Task PatchAsync(HttpClient client, string formKey, string plugin, string field, string value)
    {
        var resp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(formKey)}", new
        {
            plugin,
            fields = new Dictionary<string, object?> { [field] = value },
            source = "user",
        });
        resp.EnsureSuccessStatusCode();
    }

    private static LedgerRepository LedgerFor(string ledgerRoot) =>
        new(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);

    private static List<string> ChangedDiffLines(string diff) =>
        diff.Split('\n')
            .Where(l => (l.StartsWith('+') || l.StartsWith('-'))
                && !l.StartsWith("+++", StringComparison.Ordinal) && !l.StartsWith("---", StringComparison.Ordinal))
            .ToList();

    [Fact]
    public async Task PatchingUntrackedRecord_CreatesRepoVendorsPristineOnMainAndStagesEditAsDirt()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneMod(out var npc1, out _);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");

        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(modFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npc1).Replace('\\', '/');

        // AC1: repo exists in internal state.
        Assert.True(Directory.Exists(gitDir));
        Assert.True(File.Exists(Path.Combine(gitDir, "HEAD")));

        // AC1: pristine text is committed on main.
        var committed = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath}");
        Assert.DoesNotContain("Frenzied", committed, StringComparison.Ordinal);

        // AC1: edited text is uncommitted dirt.
        var status = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        Assert.Contains(relativePath, status, StringComparison.Ordinal);
        Assert.StartsWith(" M ", status.TrimEnd('\n'), StringComparison.Ordinal); // modified, not staged (no "M " / "A ")

        // AC (git diff): exactly the staged field change as changed YAML lines, nothing else. A
        // freshly-created NPC's Aggression sits at the enum default, which the serializer omits
        // entirely (confirmed: the committed pristine text has no Aggression line at all) — so the
        // edit renders as exactly one added line, not a paired removal/addition. Still exactly the
        // staged change, and arguably a cleaner demonstration of it than a same-line value swap
        // would have been.
        var diff = GitCli.Run(gitDir, workTree, "diff");
        var onlyChangedLine = Assert.Single(ChangedDiffLines(diff));
        Assert.StartsWith("+", onlyChangedLine, StringComparison.Ordinal);
        Assert.Contains("Frenzied", onlyChangedLine, StringComparison.Ordinal);

        // AC4: the mod folder itself contains only the text tree — no git metadata.
        Assert.DoesNotContain(Directory.GetFileSystemEntries(modFolder), e => Path.GetFileName(e) == ".git");
    }

    [Fact]
    public async Task SecondEditToADifferentRecordInTheSameMod_ReusesTheRepo()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneMod(out var npc1, out var npc2);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");
        await PatchAsync(client, npc2, "Vendor.esp", "aggression", "Frenzied");

        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(modFolder);

        // One repo, not two: both records' vendor commits land on the same main history.
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        var commitCount = log.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
        Assert.Equal(2, commitCount);

        var relPath1 = LedgerRecordPath.For("Vendor.esp", "npc_", npc1).Replace('\\', '/');
        var relPath2 = LedgerRecordPath.For("Vendor.esp", "npc_", npc2).Replace('\\', '/');
        Assert.True(ledger.IsTrackedAtHead(modFolder, LedgerRecordPath.For("Vendor.esp", "npc_", npc1)));
        Assert.True(ledger.IsTrackedAtHead(modFolder, LedgerRecordPath.For("Vendor.esp", "npc_", npc2)));
        Assert.NotEqual(relPath1, relPath2);
    }

    [Fact]
    public async Task SecondEditToAnAlreadyVendoredRecord_AddsNoNewBaselineCommit()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneMod(out var npc1, out _);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");
        await PatchAsync(client, npc1, "Vendor.esp", "confidence", "Foolhardy");

        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(modFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npc1).Replace('\\', '/');

        // AC3: still exactly one commit touching this record's path — the original vendor, not two.
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main", "--", relativePath);
        Assert.Single(log.Split('\n', StringSplitOptions.RemoveEmptyEntries));

        // Both edits landed as (still uncommitted) working-tree dirt, cumulatively.
        var diff = GitCli.Run(gitDir, workTree, "diff");
        Assert.Contains("Frenzied", diff, StringComparison.Ordinal);
        Assert.Contains("Foolhardy", diff, StringComparison.Ordinal);
    }

    // Q3 (#370, orchestrator-approved scope cut): a DataDirectory-origin plugin has no distinct mod
    // folder to vendor into — untracked is the correct truth-partition state, not a bug, but it
    // must be observable (proven here) rather than merely assumed.
    [Fact]
    public async Task PatchingRecordOnADataDirectoryOriginPlugin_CreatesNoLedgerRepo()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var flat = new TestPluginFixture(); // PluginOrigin.DataDirectory — see TestPluginFixture/Build().
        var load = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = flat.DataFolder,
            pluginsTxtPath = flat.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        await PatchAsync(client, flat.Npc1FormKey.ToString(), TestPluginFixture.PluginName, "aggression", "Frenzied");

        // The ledger root (created empty by VendoringTestHost) stays empty — no repo of any kind
        // got created for this edit, not merely "no repo for this mod folder".
        Assert.Empty(Directory.GetFileSystemEntries(ledgerRoot));
    }

    // AC5's structural half (orchestrator-revised scope): copy-on-write means first touch costs
    // exactly one baseline record file, never a whole-mod export — provable deterministically,
    // without a clock. The wall-clock number itself is measured once and reported separately, not
    // asserted here (flaky-by-plugin-size is exactly what a timing assertion in CI would risk).
    [Fact]
    public async Task PatchingUntrackedRecord_VendorsExactlyOneFile_NeverAWholeModExport()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneMod(out var npc1, out _);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");

        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var writtenFiles = Directory.GetFiles(modFolder, "*.yaml", SearchOption.AllDirectories);

        // The mod has two NPCs; only the touched one may have a ledger file. Copy-on-write, proven
        // by absence: the untouched record's own would-be path must not exist.
        Assert.Single(writtenFiles);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npc1);
        Assert.Equal(Path.Combine(modFolder, relativePath), writtenFiles[0]);
    }
}
