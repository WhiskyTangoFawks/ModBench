using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Ledger;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Api;

/// <summary>
/// #373: record lifecycle changes (create/delete/renumber) read naturally in the ledger — driven
/// end to end through the real create/delete/renumber endpoints and the real save endpoint against
/// a scattered, per-origin-folder fixture, observed through the real git CLI (never mocked) — same
/// seam and fixture style as <see cref="SaveChangeGroupLedgerCommitApiTests"/>/
/// <see cref="VendorOnFirstTouchApiTests"/>.
/// </summary>
public sealed class LifecycleLedgerApiTests
{
    private const string Plugin = "SaveTarget.esp";
    private const string Origin = "SaveMod";
    private const string ReferrerPlugin = "Referrer.esp";
    private const string ReferrerOrigin = "ReferrerMod";

    // One shared shape for every test in this file: a standalone NPC (delete/renumber targets that
    // must not entangle with anything else), a Keyword an intra-plugin NPC references (the delete
    // cascade — AddNullificationMembers nullifies inbound refs regardless of which plugin they're
    // in) and a *separate plugin's* NPC also references (the renumber cascade — Renumber's own
    // crossPluginRefs is deliberately scoped to cross-plugin references only: a same-plugin FormLink
    // remap is fixed up implicitly by Mutagen's RemapLinks during the binary write itself and never
    // becomes an explicit PendingChange row, so there is nothing for a vendoring fix to hook —
    // #373 Q2's cascade fix only ever had a member to reach for the cross-plugin case), plus a bare
    // Keyword with no EditorID (the near-empty-record rename boundary — #373 Q1: git's default
    // rename threshold cannot detect a rename whose two blobs share zero content, asserted here, not
    // hidden).
    private static ScatteredFixtureData BuildFixture(
        out string standaloneNpcFormKey, out string referrerNpcFormKey, out string crossPluginReferrerNpcFormKey,
        out string referencedKeywordFormKey, out string bareKeywordFormKey)
    {
        Mutagen.Bethesda.Plugins.FormKey standaloneFk = default, referrerFk = default,
            crossPluginReferrerFk = default, keywordFk = default, bareKeywordFk = default;
        var fx = new PluginFixtureBuilder("lifecycle-ledger")
            .WithPlugin(Plugin, mod =>
            {
                standaloneFk = mod.Npcs.AddNew("StandaloneNpc").FormKey;

                var keyword = mod.Keywords.AddNew("ReferencedKeyword");
                keywordFk = keyword.FormKey;
                bareKeywordFk = mod.Keywords.AddNew().FormKey; // no EditorID set — near-empty record

                var referrer = mod.Npcs.AddNew("ReferrerNpc");
                referrer.Keywords = [new FormLink<IKeywordGetter>(keywordFk)];
                referrerFk = referrer.FormKey;
            }, origin: Origin)
            .WithPlugin(ReferrerPlugin, (mod, built) =>
            {
                var crossPluginReferrer = mod.Npcs.AddNew("CrossPluginReferrerNpc");
                crossPluginReferrer.Keywords = [new FormLink<IKeywordGetter>(keywordFk)];
                crossPluginReferrerFk = crossPluginReferrer.FormKey;
            }, origin: ReferrerOrigin)
            .BuildScattered();

        standaloneNpcFormKey = standaloneFk.ToString();
        referrerNpcFormKey = referrerFk.ToString();
        crossPluginReferrerNpcFormKey = crossPluginReferrerFk.ToString();
        referencedKeywordFormKey = keywordFk.ToString();
        bareKeywordFormKey = bareKeywordFk.ToString();
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

    private static async Task PatchAsync(HttpClient client, string formKey, string field, object value, string plugin = Plugin)
    {
        var resp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(formKey)}", new
        {
            plugin,
            fields = new Dictionary<string, object?> { [field] = value },
            source = "user",
        });
        resp.EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement> CreateAsync(HttpClient client, string? templateFormKey = null)
    {
        var resp = await client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(Plugin)}/records",
            new { recordType = "npc_", templateFormKey, source = "user" });
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task DeleteAsync(HttpClient client, string formKey)
    {
        var resp = await client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey, plugin = Plugin } }
        });
        resp.EnsureSuccessStatusCode();
    }

    private static async Task RenumberAsync(HttpClient client, string formKey, uint newFormId)
    {
        var resp = await client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/renumber",
            new { newFormId, plugin = Plugin, source = "user" });
        resp.EnsureSuccessStatusCode();
    }

    // Saves every currently-open change group, not just one — the referrer-cascade tests stage two
    // independent groups (ADR-0028: the lifecycle change and its cascade nullify/remap only union
    // when a real dependency earns it, which a plain field edit staged *before* the renumber/delete
    // does not).
    private static async Task SaveAllGroupsAsync(HttpClient client)
    {
        var groups = await client.GetFromJsonAsync<JsonElement[]>("/change-groups") ?? [];
        foreach (var g in groups)
        {
            var resp = await client.PostAsync($"/change-groups/{g.GetProperty("id").GetString()}/save", null);
            resp.EnsureSuccessStatusCode();
        }
    }

    private static LedgerRepository LedgerFor(string ledgerRoot) =>
        new(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);

    private static (string GitDir, string WorkTree) PathsFor(string ledgerRoot, ScatteredFixtureData fx) =>
        PathsForPlugin(ledgerRoot, fx, Plugin);

    private static (string GitDir, string WorkTree) PathsForPlugin(string ledgerRoot, ScatteredFixtureData fx, string pluginName) =>
        LedgerFor(ledgerRoot).PathsFor(Path.GetDirectoryName(fx.Plugins.Single(p => p.Name == pluginName).Path)!);

    // ---------------------------------------------------------------------------------------
    // AC1 — Create.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task Create_NoTemplate_ThenSave_ProducesExactlyOneAddedRecordFileCommit()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out _, out _, out _, out _, out _);
        await LoadAsync(client, fx);

        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);
        // Nothing vendored yet at all — a create is entirely save-time (#373 orchestrator-confirmed
        // scope: no pre-save ledger visibility for lifecycle changes, so no repo exists before save).
        Assert.False(Directory.Exists(gitDir));

        var created = await CreateAsync(client);
        var createdFormKey = created.GetProperty("formKey").GetString()!;

        await SaveAllGroupsAsync(client);

        // AC1: exactly one commit for this save, and it is a pure add of the created record's file.
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        Assert.Single(log.Split('\n', StringSplitOptions.RemoveEmptyEntries));

        var relativePath = LedgerRecordPath.For(Plugin, "npc_", createdFormKey).Replace('\\', '/');
        var summary = GitCli.Run(gitDir, workTree, "show", "--summary", "--format=", "HEAD");
        Assert.Contains($"create mode 100644 {relativePath}", summary, StringComparison.Ordinal);

        var committedFiles = GitCli.Run(gitDir, workTree, "show", "--stat", "--format=", "HEAD");
        Assert.Contains(relativePath, committedFiles, StringComparison.Ordinal);

        // Nothing left dirty for the created record's own path.
        var status = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        Assert.DoesNotContain(relativePath, status, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Create_WithTemplateFields_ThenSave_LedgerContentReflectsTheTemplate()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out var standaloneNpcFormKey, out _, out _, out _, out _);
        await LoadAsync(client, fx);
        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);

        // A distinctive, non-default value on the template source, committed first (a simpler,
        // more realistic precondition than relying on the overlay to expose a still-pending edit to
        // the template read) — same field PatchAsync's own callers elsewhere in this repo already
        // know is editable.
        await PatchAsync(client, standaloneNpcFormKey, "aggression", "Frenzied");
        await SaveAllGroupsAsync(client);

        var blank = await CreateAsync(client);
        var blankFormKey = blank.GetProperty("formKey").GetString()!;

        var templated = await CreateAsync(client, templateFormKey: standaloneNpcFormKey);
        var templatedFormKey = templated.GetProperty("formKey").GetString()!;

        await SaveAllGroupsAsync(client);

        var blankRelativePath = LedgerRecordPath.For(Plugin, "npc_", blankFormKey).Replace('\\', '/');
        var templatedRelativePath = LedgerRecordPath.For(Plugin, "npc_", templatedFormKey).Replace('\\', '/');

        var blankText = GitCli.Run(gitDir, workTree, "show", $"HEAD:{blankRelativePath}");
        var templatedText = GitCli.Run(gitDir, workTree, "show", $"HEAD:{templatedRelativePath}");

        // The template carried StandaloneNpc's own staged "aggression" value onto the new record —
        // proof CreateFields actually reached the ledger write, not just a blank instantiation.
        Assert.Contains("Frenzied", templatedText, StringComparison.Ordinal);
        Assert.DoesNotContain("Frenzied", blankText, StringComparison.Ordinal);
        Assert.NotEqual(
            blankText.Replace(blankFormKey, "X", StringComparison.Ordinal),
            templatedText.Replace(templatedFormKey, "X", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------------------------------
    // AC2 — Delete.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task Delete_NotYetVendoredRecord_ThenSave_HistoryShowsVendorThenRemove_DiffExposesRemovedContent()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out var standaloneNpcFormKey, out _, out _, out _, out _);
        await LoadAsync(client, fx);
        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);

        Assert.False(Directory.Exists(gitDir)); // never touched before

        await DeleteAsync(client, standaloneNpcFormKey);

        // Stage time already vendored the pristine baseline (before the delete's own save-time
        // binary write could erase it) — the repo exists and carries one commit, even though
        // nothing has been saved yet.
        Assert.True(Directory.Exists(gitDir));
        var beforeSaveLog = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        Assert.Single(beforeSaveLog.Split('\n', StringSplitOptions.RemoveEmptyEntries));

        await SaveAllGroupsAsync(client);

        // History shows vendor-then-remove: two commits total.
        var log = GitCli.Run(gitDir, workTree, "log", "--format=%s", "main");
        var subjects = log.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2, subjects.Length);
        Assert.StartsWith("vendor:", subjects[1], StringComparison.Ordinal); // oldest first in --format order? verify below
    }

    [Fact]
    public async Task Delete_NotYetVendoredRecord_ThenSave_RemovalCommitDiffShowsTheRemovedContent()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out var standaloneNpcFormKey, out _, out _, out _, out _);
        await LoadAsync(client, fx);
        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);

        await DeleteAsync(client, standaloneNpcFormKey);
        await SaveAllGroupsAsync(client);

        var relativePath = LedgerRecordPath.For(Plugin, "npc_", standaloneNpcFormKey).Replace('\\', '/');

        // The most recent commit ("save: ...") is the removal — its own diff must show the removed
        // text, not an empty diff: the AC's own "exposes the removed content" bar.
        var diff = GitCli.Run(gitDir, workTree, "show", "--format=", "HEAD");
        Assert.Contains($"deleted file mode", diff, StringComparison.Ordinal);
        Assert.Contains(relativePath, diff, StringComparison.Ordinal);
        Assert.Contains($"-FormKey: {standaloneNpcFormKey}", diff, StringComparison.Ordinal);

        // And working tree is clean — the file is genuinely gone, not just staged as gone.
        var absolutePath = Path.Combine(workTree, relativePath);
        Assert.False(File.Exists(absolutePath));
        var status = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        Assert.DoesNotContain(relativePath, status, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Delete_AlreadyVendoredRecord_ThenSave_OnlyOneNewCommitForTheRemoval()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out var standaloneNpcFormKey, out _, out _, out _, out _);
        await LoadAsync(client, fx);
        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);

        await PatchAsync(client, standaloneNpcFormKey, "aggression", "Frenzied");
        await SaveAllGroupsAsync(client); // vendor + this save = 2 commits

        Assert.Equal(2, GitCli.Run(gitDir, workTree, "log", "--oneline", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);

        await DeleteAsync(client, standaloneNpcFormKey);
        await SaveAllGroupsAsync(client);

        // No-op-safe vendor (already tracked) + exactly one new commit for the removal = 3 total.
        Assert.Equal(3, GitCli.Run(gitDir, workTree, "log", "--oneline", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
    }

    // ---------------------------------------------------------------------------------------
    // AC3 — Renumber. Q1: git's default (unmodified) rename threshold — never lowered.
    // ---------------------------------------------------------------------------------------

    [Fact]
    public async Task Renumber_RealisticallyFieldedRecord_ThenSave_GitRendersRenamePlusContentChange_AtDefaultThreshold()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out var standaloneNpcFormKey, out _, out _, out _, out _);
        await LoadAsync(client, fx);
        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);

        const uint newFormId = 0x900000;
        await RenumberAsync(client, standaloneNpcFormKey, newFormId);
        await SaveAllGroupsAsync(client);

        var newFormKey = $"{newFormId:X6}:{Plugin}";
        var oldRelativePath = LedgerRecordPath.For(Plugin, "npc_", standaloneNpcFormKey).Replace('\\', '/');
        var newRelativePath = LedgerRecordPath.For(Plugin, "npc_", newFormKey).Replace('\\', '/');

        // Default threshold, no -M override anywhere (#373 orchestrator decision Q1) — git's own
        // `-M` bare form (default 50%) is enough for a record carrying real content beyond its own
        // identity line.
        var summary = GitCli.Run(gitDir, workTree, "show", "--summary", "-M", "--format=", "HEAD");
        Assert.Contains("rename", summary, StringComparison.Ordinal);
        Assert.Contains(Path.GetFileName(oldRelativePath), summary, StringComparison.Ordinal);
        Assert.Contains(Path.GetFileName(newRelativePath), summary, StringComparison.Ordinal);

        // Content change: the new file's own FormKey line differs from the old one's.
        var newText = GitCli.Run(gitDir, workTree, "show", $"HEAD:{newRelativePath}");
        Assert.Contains(newFormKey, newText, StringComparison.Ordinal);
        Assert.DoesNotContain(standaloneNpcFormKey, newText, StringComparison.Ordinal);

        // Old path is gone from HEAD and from disk.
        Assert.False(GitCli.TryRun(gitDir, workTree, out _, "cat-file", "-e", $"HEAD:{oldRelativePath}"));
        Assert.False(File.Exists(Path.Combine(workTree, oldRelativePath)));
    }

    // Q1's pinned boundary: a near-empty record (no EditorID — its ledger text is exactly its own
    // FormKey line, so old and new blobs share zero content) renumbered renders as delete+add, not
    // a rename, at git's own default threshold — and no threshold could fix that (zero overlap is
    // structural, not a tuning problem). Asserted as expected behaviour, not treated as a defect.
    [Fact]
    public async Task Renumber_NearEmptyRecord_ThenSave_RendersAsDeleteAndAdd_NotARename_KnownBoundary()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out _, out _, out _, out _, out var bareKeywordFormKey);
        await LoadAsync(client, fx);
        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);

        const uint newFormId = 0x900001;
        await RenumberAsync(client, bareKeywordFormKey, newFormId);
        await SaveAllGroupsAsync(client);

        var newFormKey = $"{newFormId:X6}:{Plugin}";
        var oldRelativePath = LedgerRecordPath.For(Plugin, "kywd", bareKeywordFormKey).Replace('\\', '/');
        var newRelativePath = LedgerRecordPath.For(Plugin, "kywd", newFormKey).Replace('\\', '/');

        var summary = GitCli.Run(gitDir, workTree, "show", "--summary", "-M", "--format=", "HEAD");
        Assert.DoesNotContain("rename", summary, StringComparison.Ordinal);
        Assert.Contains($"delete mode 100644 {oldRelativePath}", summary, StringComparison.Ordinal);
        Assert.Contains($"create mode 100644 {newRelativePath}", summary, StringComparison.Ordinal);

        // Still round-trips: the new record exists with the new identity, old one is gone. A
        // delete+add pair is exactly as sound a record of "this record moved" as a rename is — git
        // simply can't *label* it that way from content alone here.
        var newText = GitCli.Run(gitDir, workTree, "show", $"HEAD:{newRelativePath}");
        Assert.Contains(newFormKey, newText, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------------------------------
    // Referrer cascade (#373 Q2): Renumber/DeleteRecords stage referrer field_edit changes via
    // StageChanges directly, bypassing StageEdit's own vendoring hook — must be vendored anyway, or
    // an already-tracked referrer's ledger file keeps stale content while its binary field
    // genuinely changes.
    // ---------------------------------------------------------------------------------------

    // Deliberately a *cross-plugin* referrer (Renumber's own crossPluginRefs scope — see
    // BuildFixture's remarks): an intra-plugin FormLink remap never produces a PendingChange row at
    // all (Mutagen's own RemapLinks fixes it up implicitly during the binary write), so there would
    // be no cascade member to vendor and this test would prove nothing.
    [Fact]
    public async Task Renumber_ReferencedByAnAlreadyTrackedCrossPluginRecord_UpdatesTheReferrersLedgerFileToo()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out _, out _, out var crossPluginReferrerNpcFormKey, out var referencedKeywordFormKey, out _);
        await LoadAsync(client, fx);
        var (referrerGitDir, referrerWorkTree) = PathsForPlugin(host.LedgerRoot, fx, ReferrerPlugin);

        // Vendor the referrer via an unrelated field edit first — a real "already tracked before
        // this renumber" precondition, not a bare fixture assumption.
        await PatchAsync(client, crossPluginReferrerNpcFormKey, "aggression", "Frenzied", plugin: ReferrerPlugin);

        const uint newFormId = 0x900002;
        await RenumberAsync(client, referencedKeywordFormKey, newFormId);
        var newKeywordFormKey = $"{newFormId:X6}:{Plugin}";

        await SaveAllGroupsAsync(client);

        var referrerRelativePath = LedgerRecordPath.For(ReferrerPlugin, "npc_", crossPluginReferrerNpcFormKey).Replace('\\', '/');
        var referrerText = GitCli.Run(referrerGitDir, referrerWorkTree, "show", $"HEAD:{referrerRelativePath}");

        Assert.Contains(newKeywordFormKey, referrerText, StringComparison.Ordinal);
        Assert.DoesNotContain(referencedKeywordFormKey, referrerText, StringComparison.Ordinal);

        // Clean afterwards — the cascade's own vendor-refresh didn't leave stray dirt uncommitted.
        var status = GitCli.Run(referrerGitDir, referrerWorkTree, "status", "--porcelain");
        Assert.DoesNotContain(referrerRelativePath, status, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Delete_ReferencedByAnAlreadyTrackedRecord_NullifiesTheReferrersLedgerFileToo()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        using var fx = BuildFixture(out _, out var referrerNpcFormKey, out _, out var referencedKeywordFormKey, out _);
        await LoadAsync(client, fx);
        var (gitDir, workTree) = PathsFor(host.LedgerRoot, fx);

        await PatchAsync(client, referrerNpcFormKey, "aggression", "Frenzied");

        await DeleteAsync(client, referencedKeywordFormKey);
        await SaveAllGroupsAsync(client);

        var referrerRelativePath = LedgerRecordPath.For(Plugin, "npc_", referrerNpcFormKey).Replace('\\', '/');
        var referrerText = GitCli.Run(gitDir, workTree, "show", $"HEAD:{referrerRelativePath}");

        // The nullified FormLink no longer names the deleted keyword.
        Assert.DoesNotContain(referencedKeywordFormKey, referrerText, StringComparison.Ordinal);
    }
}
