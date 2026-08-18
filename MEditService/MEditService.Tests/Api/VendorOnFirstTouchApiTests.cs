using System.Net.Http.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Api;

/// <summary>
/// #370 Slice A2/B/C/Q3/H (plus review fixes): the ledger's own git repo, observed through the real
/// git CLI (never mocked) — driven end-to-end through the real stage endpoint
/// (<c>PATCH /records/{formKey}</c>) against a scattered, per-origin-folder fixture (<see
/// cref="PluginFixtureBuilder.BuildScattered"/>), matching how a real MO2-style install actually
/// looks (one folder per plugin, unlike the flat single-folder <see cref="TestPluginFixture"/> most
/// other API tests use).
/// </summary>
public class VendorOnFirstTouchApiTests
{
    private static ScatteredFixtureData BuildTwoNpcFixture(out string npc1, out string npc2)
    {
        // Two NPCs per origin: the second FormKey backs the "reuses the repo" scenario.
        Mutagen.Bethesda.Plugins.FormKey f1 = default, f2 = default;
        var fx = new PluginFixtureBuilder("vendor-on-first-touch")
            .WithPlugin("Vendor.esp", mod =>
            {
                f1 = mod.Npcs.AddNew("VendorNpc1").FormKey;
                f2 = mod.Npcs.AddNew("VendorNpc2").FormKey;
            }, origin: "VendorMod")
            .BuildScattered();
        npc1 = f1.ToString();
        npc2 = f2.ToString();
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
        using var fx = BuildTwoNpcFixture(out var npc1, out _);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
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
        // entirely (confirmed: the committed pristine text has no Aggression line at all) — so this
        // additive case renders as exactly one added line, not a paired removal/addition. Still
        // exactly the staged change. See the sibling test below for the paired-line (value-swap)
        // case a non-default pristine value produces.
        var diff = GitCli.Run(gitDir, workTree, "diff");
        var onlyChangedLine = Assert.Single(ChangedDiffLines(diff));
        Assert.StartsWith("+", onlyChangedLine, StringComparison.Ordinal);
        Assert.Contains("Frenzied", onlyChangedLine, StringComparison.Ordinal);

        // AC4: the origin folder itself contains only the text tree — no git metadata.
        Assert.DoesNotContain(Directory.GetFileSystemEntries(originFolder), e => Path.GetFileName(e) == ".git");
    }

    // Spec review finding 2: the additive test above happens to pick a field whose pristine value is
    // the omitted enum default, so it only ever proves a `+`-only diff. The representative case for
    // "git diff renders exactly the staged change" is a genuine `-old`/`+new` swap on a field that
    // already had a non-default value in the committed pristine text — proven here by setting
    // Aggression explicitly at fixture-build time (not left at its default) before editing it.
    [Fact]
    public async Task PatchingUntrackedRecord_ValueSwapOnANonDefaultPristineField_RendersAsRemovedAndAddedLine()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;

        Mutagen.Bethesda.Plugins.FormKey npcFk = default;
        using var fx = new PluginFixtureBuilder("vendor-value-swap")
            .WithPlugin("Vendor.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("VendorNpc");
                npc.Aggression = Npc.AggressionType.Aggressive; // non-default: appears in pristine text
                npcFk = npc.FormKey;
            }, origin: "VendorMod")
            .BuildScattered();
        var npcFormKey = npcFk.ToString();
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFormKey, "Vendor.esp", "aggression", "Frenzied");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npcFormKey).Replace('\\', '/');

        var committed = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath}");
        Assert.Contains("Aggressive", committed, StringComparison.Ordinal);

        var diff = GitCli.Run(gitDir, workTree, "diff");
        var changed = ChangedDiffLines(diff);
        Assert.Equal(2, changed.Count);
        Assert.Contains(changed, l => l.StartsWith('-') && l.Contains("Aggressive", StringComparison.Ordinal));
        Assert.Contains(changed, l => l.StartsWith('+') && l.Contains("Frenzied", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SecondEditToADifferentRecordInTheSameOrigin_ReusesTheRepo()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildTwoNpcFixture(out var npc1, out var npc2);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");
        await PatchAsync(client, npc2, "Vendor.esp", "aggression", "Frenzied");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);

        // One repo, not two: both records' vendor commits land on the same main history.
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        var commitCount = log.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
        Assert.Equal(2, commitCount);

        var relPath1 = LedgerRecordPath.For("Vendor.esp", "npc_", npc1).Replace('\\', '/');
        var relPath2 = LedgerRecordPath.For("Vendor.esp", "npc_", npc2).Replace('\\', '/');
        Assert.True(ledger.IsTrackedAtHead(originFolder, LedgerRecordPath.For("Vendor.esp", "npc_", npc1)));
        Assert.True(ledger.IsTrackedAtHead(originFolder, LedgerRecordPath.For("Vendor.esp", "npc_", npc2)));
        Assert.NotEqual(relPath1, relPath2);
    }

    [Fact]
    public async Task SecondEditToAnAlreadyVendoredRecord_AddsNoNewBaselineCommit()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildTwoNpcFixture(out var npc1, out _);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");
        await PatchAsync(client, npc1, "Vendor.esp", "confidence", "Foolhardy");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npc1).Replace('\\', '/');

        // AC3: still exactly one commit touching this record's path — the original vendor, not two.
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main", "--", relativePath);
        Assert.Single(log.Split('\n', StringSplitOptions.RemoveEmptyEntries));

        // Both edits landed as (still uncommitted) working-tree dirt, cumulatively.
        var diff = GitCli.Run(gitDir, workTree, "diff");
        Assert.Contains("Frenzied", diff, StringComparison.Ordinal);
        Assert.Contains("Foolhardy", diff, StringComparison.Ordinal);
    }

    // Q3 (#370, orchestrator-approved scope cut): a DataDirectory-origin plugin has no distinct
    // origin folder to vendor into — untracked is the correct truth-partition state, not a bug, but
    // it must be observable (proven here) rather than merely assumed.
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
        // got created for this edit, not merely "no repo for this origin folder".
        Assert.Empty(Directory.GetFileSystemEntries(ledgerRoot));
    }

    // AC5's structural half (orchestrator-revised scope): copy-on-write means first touch costs
    // exactly one baseline record file, never a whole-mod export (ADR-0040's own rejected-alternative
    // terminology — the whole-plugin serialization path spike #359 measured and rejected, not a
    // reference to Mod Management's "mod") — provable deterministically, without a clock. The
    // wall-clock number itself is measured once and reported separately, not asserted here
    // (flaky-by-plugin-size is exactly what a timing assertion in CI would risk).
    [Fact]
    public async Task PatchingUntrackedRecord_VendorsExactlyOneFile_NeverAWholeModExport()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildTwoNpcFixture(out var npc1, out _);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var writtenFiles = Directory.GetFiles(originFolder, "*.yaml", SearchOption.AllDirectories);

        // The origin has two NPCs; only the touched one may have a ledger file. Copy-on-write,
        // proven by absence: the untouched record's own would-be path must not exist.
        Assert.Single(writtenFiles);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npc1);
        Assert.Equal(Path.Combine(originFolder, relativePath), writtenFiles[0]);
    }

    // Review finding 1 (the most serious one): a FormKey's local ID is only unique within its own
    // origin ModKey. Two records that originate in *different* masters but happen to share a local
    // ID, both edited through the same target plugin (the routine "override" case
    // RecordQueryService.GetRecordForPlugin exists for), must vendor to distinct paths with their
    // own, uncorrupted content — not silently overwrite each other. This also doubles as the
    // mutation-testing guard for VendorPristineThenDirtAsync's record-lookup predicate (survived
    // mutants included inverting it to `!=`): asserting each record's *content*, not just that two
    // files exist, is what would catch a predicate that finds the wrong record.
    [Fact]
    public async Task TwoRecordsSharingALocalFormIdAcrossDifferentOriginMasters_VendorToDistinctPathsWithCorrectContent()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;

        using var fx = new PluginFixtureBuilder("vendor-collision")
            .WithPlugin("Master1.esm", mod => mod.Npcs.AddNew("Master1Npc"), origin: "Master1Mod")
            .WithPlugin("Master2.esm", mod => mod.Npcs.AddNew("Master2Npc"), origin: "Master2Mod")
            .WithPlugin("Vendor.esp", (mod, priorMods) =>
            {
                mod.Npcs.GetOrAddAsOverride(priorMods[0].Npcs.First()); // Master1.esm's NPC
                mod.Npcs.GetOrAddAsOverride(priorMods[1].Npcs.First()); // Master2.esm's NPC
            }, origin: "VendorMod")
            .BuildScattered();
        await LoadAsync(client, fx);

        const string master1FormKey = "000800:Master1.esm";
        const string master2FormKey = "000800:Master2.esm";

        await PatchAsync(client, master1FormKey, "Vendor.esp", "aggression", "Frenzied");
        await PatchAsync(client, master2FormKey, "Vendor.esp", "aggression", "VeryAggressive");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var relativePath1 = LedgerRecordPath.For("Vendor.esp", "npc_", master1FormKey);
        var relativePath2 = LedgerRecordPath.For("Vendor.esp", "npc_", master2FormKey);

        // The bug fixed: distinct paths despite the shared local ID.
        Assert.NotEqual(relativePath1, relativePath2);

        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var gitPath1 = relativePath1.Replace('\\', '/');
        var gitPath2 = relativePath2.Replace('\\', '/');

        // Each record's own pristine baseline holds its own *identity* — FormKey and EditorID —
        // never the other's. This, not the field-value assertions below, is what a wrong-record
        // lookup (e.g. the record-lookup predicate inverted to `!=`, mutation-tested) would break:
        // asserting only that an edited value appears somewhere is satisfied even by a swap, since
        // both records got a real (if wrong) edit applied and serialized.
        var pristine1 = GitCli.Run(gitDir, workTree, "show", $"main:{gitPath1}");
        var pristine2 = GitCli.Run(gitDir, workTree, "show", $"main:{gitPath2}");
        Assert.Contains($"FormKey: {master1FormKey}", pristine1, StringComparison.Ordinal);
        Assert.DoesNotContain($"FormKey: {master2FormKey}", pristine1, StringComparison.Ordinal);
        Assert.Contains("Master1Npc", pristine1, StringComparison.Ordinal);
        Assert.DoesNotContain("Master2Npc", pristine1, StringComparison.Ordinal);

        Assert.Contains($"FormKey: {master2FormKey}", pristine2, StringComparison.Ordinal);
        Assert.DoesNotContain($"FormKey: {master1FormKey}", pristine2, StringComparison.Ordinal);
        Assert.Contains("Master2Npc", pristine2, StringComparison.Ordinal);
        Assert.DoesNotContain("Master1Npc", pristine2, StringComparison.Ordinal);

        // Each record's own dirt carries only its own staged edit.
        var dirt1 = await File.ReadAllTextAsync(Path.Combine(originFolder, relativePath1));
        var dirt2 = await File.ReadAllTextAsync(Path.Combine(originFolder, relativePath2));
        Assert.Contains("Frenzied", dirt1, StringComparison.Ordinal);
        Assert.DoesNotContain("VeryAggressive", dirt1, StringComparison.Ordinal);
        Assert.Contains("VeryAggressive", dirt2, StringComparison.Ordinal);
        Assert.DoesNotContain("Frenzied", dirt2, StringComparison.Ordinal);
    }

    // Mutation-testing finding 1: nothing exercised ContainerStripFields.StripInPlace actually
    // running *inside* RecordVendor's own pipeline — every existing container test called it
    // directly. Proves the constraint where it actually operates: staging an edit to a populated
    // Cell through the real endpoint must still vendor exactly one file, with the children absent.
    [Fact]
    public async Task PatchingContainerRecord_VendorsShallow_ExactlyOneFileWithChildrenAbsent()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;

        Mutagen.Bethesda.Plugins.FormKey cellFk = default;
        using var fx = new PluginFixtureBuilder("vendor-container-shallow")
            .WithPlugin("VendorCell.esp", mod =>
            {
                var cell = new Cell(mod) { EditorID = "VendorCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                cell.Persistent.Add(new PlacedObject(mod) { EditorID = "PersistentRef" });
                cell.Temporary.Add(new PlacedObject(mod) { EditorID = "TemporaryRef" });
                cell.NavigationMeshes.Add(new NavigationMesh(mod));
                cell.Landscape = new Landscape(mod);

                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(cell);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);

                cellFk = cell.FormKey;
            }, origin: "CellMod")
            .BuildScattered();
        var cellFormKey = cellFk.ToString();
        await LoadAsync(client, fx);

        await PatchAsync(client, cellFormKey, "VendorCell.esp", "water_height", 500.0);

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "CellMod").Path)!;
        var relativePath = LedgerRecordPath.For("VendorCell.esp", "cell", cellFormKey);

        // Exactly one ledger file — no sibling Persistent/Temporary/NavigationMeshes folders next to
        // it, which is exactly the cross-contamination hazard #387 probed.
        var writtenFiles = Directory.GetFiles(originFolder, "*.yaml", SearchOption.AllDirectories);
        Assert.Equal([Path.Combine(originFolder, relativePath)], writtenFiles);

        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var committed = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath.Replace('\\', '/')}");

        // Children absent from the committed pristine text — not just "no sibling files", the
        // parent's own file carries none of their content either.
        Assert.DoesNotContain("PersistentRef", committed, StringComparison.Ordinal);
        Assert.DoesNotContain("TemporaryRef", committed, StringComparison.Ordinal);

        var dirt = await File.ReadAllTextAsync(Path.Combine(originFolder, relativePath));
        Assert.Contains("500", dirt, StringComparison.Ordinal);
    }

    // #389 AC1: a VMAD struct-op edit (a different payload shape than the plain fields branch above
    // — path -> op object, not path -> value) vendors on first touch too, driven end to end through
    // the same PATCH endpoint with changeType: "vmad_struct_op".
    [Fact]
    public async Task PatchingUntrackedRecordWithVmadStructOp_CreatesRepoVendorsPristineOnMainAndStagesEditAsDirt()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildTwoNpcFixture(out var npc1, out _);
        await LoadAsync(client, fx);

        var resp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(npc1)}", new
        {
            plugin = "Vendor.esp",
            fields = new Dictionary<string, object?>
            {
                [@"VMAD\NewScript"] = new { op = "add_script", name = "NewScript", flags = "Local", properties = Array.Empty<object>() },
            },
            source = "user",
            changeType = "vmad_struct_op",
        });
        resp.EnsureSuccessStatusCode();

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npc1).Replace('\\', '/');

        Assert.True(Directory.Exists(gitDir));
        Assert.True(File.Exists(Path.Combine(gitDir, "HEAD")));

        var committed = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath}");
        Assert.DoesNotContain("NewScript", committed, StringComparison.Ordinal);

        var status = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        Assert.Contains(relativePath, status, StringComparison.Ordinal);
        Assert.StartsWith(" M ", status.TrimEnd('\n'), StringComparison.Ordinal);

        var diff = GitCli.Run(gitDir, workTree, "diff");
        Assert.Contains("NewScript", diff, StringComparison.Ordinal);
    }

    // #389 AC3: a record already vendored by a plain field edit is not re-baselined by a subsequent
    // VMAD struct-op edit — IsTrackedAtHead's existing "no-op-safe to call repeatedly" contract
    // (AC3 of #370) covers this for free once the struct-op branch reaches VendorOnFirstTouch at
    // all, but it must actually be exercised through this shape, not merely assumed.
    [Fact]
    public async Task AVmadStructOpEditOnARecordAlreadyVendoredByAPlainFieldEdit_AddsNoNewBaselineCommit()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildTwoNpcFixture(out var npc1, out _);
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1, "Vendor.esp", "aggression", "Frenzied");

        var structOpResp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(npc1)}", new
        {
            plugin = "Vendor.esp",
            fields = new Dictionary<string, object?>
            {
                [@"VMAD\NewScript"] = new { op = "add_script", name = "NewScript", flags = "Local", properties = Array.Empty<object>() },
            },
            source = "user",
            changeType = "vmad_struct_op",
        });
        structOpResp.EnsureSuccessStatusCode();

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", npc1).Replace('\\', '/');

        // Still exactly one commit touching this record's path — the original vendor baseline, not
        // a second one fabricated by the struct-op edit.
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main", "--", relativePath);
        Assert.Single(log.Split('\n', StringSplitOptions.RemoveEmptyEntries));

        // Both edits' effects landed as (still uncommitted) working-tree dirt, cumulatively.
        var diff = GitCli.Run(gitDir, workTree, "diff");
        Assert.Contains("Frenzied", diff, StringComparison.Ordinal);
        Assert.Contains("NewScript", diff, StringComparison.Ordinal);
    }
}
