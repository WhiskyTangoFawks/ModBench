using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Api;

/// <summary>
/// #371 AC3: reverting a record to an earlier committed ledger text state, re-applied through the
/// normal save path. No wire endpoint exists for the revert step itself (orchestrator-directed,
/// #371 — mirrors the Q3/Q4 "no speculative wire surface" ruling; a user-facing revert command is
/// #368/#380's to wire up), so it is invoked directly against the real, DI-resolved
/// <see cref="IEditOrchestrator"/> the API host itself uses — the setup edits/saves and the final
/// save that actually re-applies the reverted state to the binary all go through the real
/// <c>PATCH</c>/<c>POST /change-groups/{id}/save</c> endpoints, same as
/// <see cref="SaveChangeGroupLedgerCommitApiTests"/>. Git is never mocked.
/// </summary>
public class RevertRecordLedgerApiTests
{
    private static ScatteredFixtureData BuildOneNpcFixture(out string npcFormKey)
    {
        FormKey fk = default;
        var fx = new PluginFixtureBuilder("revert-ledger")
            .WithPlugin("RevertTarget.esp", mod => fk = mod.Npcs.AddNew("RevertNpc").FormKey, origin: "RevertMod")
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

    private static async Task PatchAsync(HttpClient client, string formKey, string plugin, string field, object? value)
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

    private static async Task SaveSingleGroupAsync(HttpClient client)
    {
        var groupId = await SingleGroupIdAsync(client);
        (await client.PostAsync($"/change-groups/{groupId}/save", null)).EnsureSuccessStatusCode();
    }

    private static LedgerRepository LedgerFor(string ledgerRoot) =>
        new(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);

    [Fact]
    public async Task RevertToAnEarlierCommit_ReAppliesThroughTheNormalSavePath()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        var ledgerRoot = host.LedgerRoot;
        using var fx = BuildOneNpcFixture(out var npcFormKey);
        await LoadAsync(client, fx);

        // Commit A: vendors + saves "Frenzied".
        await PatchAsync(client, npcFormKey, "RevertTarget.esp", "aggression", "Frenzied");
        await SaveSingleGroupAsync(client);

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "RevertMod").Path)!;
        var ledger = LedgerFor(ledgerRoot);
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var commitA = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%H", "main").Trim();

        // Commit B: edits + saves "Aggressive" — the state we're about to revert away from.
        await PatchAsync(client, npcFormKey, "RevertTarget.esp", "aggression", "Aggressive");
        await SaveSingleGroupAsync(client);

        var afterB = await client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(npcFormKey)}");
        Assert.Equal("Aggressive", FieldValue(afterB, "aggression"));

        // Revert to commit A, then save through the real endpoint — no wire surface for the revert
        // step itself (see class remarks), so it's invoked directly against the same DI-resolved
        // orchestrator the API host uses.
        var orchestrator = host.App.Services.GetRequiredService<IEditOrchestrator>();
        var revertResult = await orchestrator.RevertRecordToLedgerCommitAsync(npcFormKey, "RevertTarget.esp", commitA, "user");
        Assert.IsType<StageEditResult.Staged>(revertResult);

        await SaveSingleGroupAsync(client);

        // AC3, binary half: the normal save path re-applied the reverted value to the actual plugin
        // binary — read back through the same GetRecord endpoint every other test uses.
        var afterRevert = await client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(npcFormKey)}");
        Assert.Equal("Frenzied", FieldValue(afterRevert, "aggression"));

        // AC3, ledger half: a *new* forward commit, not a history rewrite (git's own "revert" —
        // ADR-0040's surviving vocabulary) — four commits total (vendor baseline + three saves).
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        Assert.Equal(4, log.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
        var newestCommit = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%H", "main").Trim();
        Assert.NotEqual(commitA, newestCommit);

        var relativePath = LedgerRecordPath.For("RevertTarget.esp", "npc_", npcFormKey).Replace('\\', '/');
        var committedAtHead = GitCli.Run(gitDir, workTree, "show", $"main:{relativePath}");
        Assert.Contains("Frenzied", committedAtHead, StringComparison.Ordinal);
    }

    private static string? FieldValue(JsonElement detail, string fieldName) =>
        detail.GetProperty("fields").EnumerateArray()
            .First(f => f.GetProperty("metadata").GetProperty("name").GetString() == fieldName)
            .GetProperty("value").GetString();

    // #371 review (mutation axis + spec reviewer): the diff-and-stage *decision* itself, not just
    // the read leg's round-trip fidelity (LedgerRecordFieldReaderTests) — a field changing to
    // null, a field changing from null, an array changing length, and the null-vs-empty-array
    // distinction. Both sides of the diff serialize through the identical GetRecord/JsonSerializer
    // path (Q1), so these assert on the *decision* (which field(s) got staged, and with what
    // value) via StageEditResult.Staged.Changes directly — no Save needed to prove this half.

    // "A field changing to null": pristine keywords is unset (Mutagen null, never assigned);
    // staging a real value moves it away from that; reverting must stage null back.
    [Fact]
    public async Task RevertToAnEarlierCommit_FieldChangingToNull_StagesNull()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        Mutagen.Bethesda.Plugins.FormKey npcFk = default, kwFk = default;
        using var fx = new PluginFixtureBuilder("revert-to-null")
            .WithPlugin("RevertTarget.esp", mod =>
            {
                kwFk = mod.Keywords.AddNew().FormKey;
                npcFk = mod.Npcs.AddNew("RevertNpc").FormKey; // Keywords left unset — pristine is null.
            }, origin: "RevertMod")
            .BuildScattered();
        var npcFormKey = npcFk.ToString();
        await LoadAsync(client, fx);

        // Commit A: vendors pristine (keywords unset/null) — captured before the save below moves
        // the *committed* state away from it (RecordQueryService.GetRecordForPlugin, what the diff
        // reads for "current", is committed-only — ADR-0025's overlay view was never implemented,
        // per ADR-0040's own "Relation to existing ADRs" section; confirmed empirically here).
        await PatchAsync(client, npcFormKey, "RevertTarget.esp", "keywords", new[] { kwFk.ToString() });
        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "RevertMod").Path)!;
        var (gitDir, workTree) = LedgerFor(host.LedgerRoot).PathsFor(originFolder);
        var commitA = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%H", "main").Trim();
        await SaveSingleGroupAsync(client);

        var orchestrator = host.App.Services.GetRequiredService<IEditOrchestrator>();
        var revertResult = await orchestrator.RevertRecordToLedgerCommitAsync(npcFormKey, "RevertTarget.esp", commitA, "user");

        var staged = Assert.IsType<StageEditResult.Staged>(revertResult);
        var change = Assert.Single(staged.Changes);
        Assert.Equal("keywords", change.FieldPath);
        Assert.Equal(JsonValueKind.Null, change.NewValue.ValueKind);
    }

    // "A field changing from null" moved to
    // MEditService.Tests.Edits.RevertRecordToLedgerCommitTests.RevertRecordToLedgerCommitAsync_FieldChangingFromNull_StagesTheHistoricalValue:
    // every writable field nullable enough to reach that transition through a real save turned out
    // not to exist on NPC_ (probed directly — every nullable top-level scalar FormLink column is
    // read-only, and ApplyListJson no-ops on a null array value by design), so that test manipulates
    // the committed index directly rather than pretending an unreachable write happened through
    // PluginWriter — a technique that needs the repository's own connection, not available through
    // this file's API-host seam.

    // "An array changing length": pristine keywords has two elements; the current, staged value
    // clears it to empty; reverting must stage the full two-element array back, not a truncated one.
    [Fact]
    public async Task RevertToAnEarlierCommit_ArrayLengthChange_StagesTheLongerHistoricalArray()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        Mutagen.Bethesda.Plugins.FormKey npcFk = default, kw1Fk = default, kw2Fk = default;
        using var fx = new PluginFixtureBuilder("revert-array-length")
            .WithPlugin("RevertTarget.esp", mod =>
            {
                var kw1 = mod.Keywords.AddNew();
                kw1Fk = kw1.FormKey;
                var kw2 = mod.Keywords.AddNew();
                kw2Fk = kw2.FormKey;
                var npc = mod.Npcs.AddNew("RevertNpc");
                npc.Keywords = [new FormLink<IKeywordGetter>(kw1.FormKey), new FormLink<IKeywordGetter>(kw2.FormKey)]; // pristine length 2
                npcFk = npc.FormKey;
            }, origin: "RevertMod")
            .BuildScattered();
        var npcFormKey = npcFk.ToString();
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFormKey, "RevertTarget.esp", "keywords", Array.Empty<string>());
        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "RevertMod").Path)!;
        var (gitDir, workTree) = LedgerFor(host.LedgerRoot).PathsFor(originFolder);
        var commitA = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%H", "main").Trim();
        await SaveSingleGroupAsync(client);

        var orchestrator = host.App.Services.GetRequiredService<IEditOrchestrator>();
        var revertResult = await orchestrator.RevertRecordToLedgerCommitAsync(npcFormKey, "RevertTarget.esp", commitA, "user");

        var staged = Assert.IsType<StageEditResult.Staged>(revertResult);
        var change = Assert.Single(staged.Changes);
        Assert.Equal("keywords", change.FieldPath);
        Assert.Equal(
            [kw1Fk.ToString(), kw2Fk.ToString()],
            change.NewValue.EnumerateArray().Select(e => e.GetString()));
    }

    // The null-vs-empty-array distinction, on the diff/staging decision itself (LedgerRecordFieldReaderTests
    // already proved it on the read leg): pristine keywords is *explicitly* empty (assigned `[]`,
    // not left unset/null), so reverting to it must stage an empty array — never null, and never
    // silently omitted as "nothing to revert".
    [Fact]
    public async Task RevertToAnEarlierCommit_EmptyArrayNotNull_StagesAnEmptyArray_NotNullOrOmitted()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;
        Mutagen.Bethesda.Plugins.FormKey npcFk = default, kwFk = default;
        using var fx = new PluginFixtureBuilder("revert-empty-not-null")
            .WithPlugin("RevertTarget.esp", mod =>
            {
                kwFk = mod.Keywords.AddNew().FormKey;
                var npc = mod.Npcs.AddNew("RevertNpc");
                npc.Keywords = []; // pristine explicitly empty
                npcFk = npc.FormKey;
            }, origin: "RevertMod")
            .BuildScattered();
        var npcFormKey = npcFk.ToString();
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFormKey, "RevertTarget.esp", "keywords", new[] { kwFk.ToString() });
        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "RevertMod").Path)!;
        var (gitDir, workTree) = LedgerFor(host.LedgerRoot).PathsFor(originFolder);
        var commitA = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%H", "main").Trim();
        await SaveSingleGroupAsync(client);

        var orchestrator = host.App.Services.GetRequiredService<IEditOrchestrator>();
        var revertResult = await orchestrator.RevertRecordToLedgerCommitAsync(npcFormKey, "RevertTarget.esp", commitA, "user");

        var staged = Assert.IsType<StageEditResult.Staged>(revertResult);
        var change = Assert.Single(staged.Changes);
        Assert.Equal("keywords", change.FieldPath);
        Assert.Equal(JsonValueKind.Array, change.NewValue.ValueKind);
        Assert.Empty(change.NewValue.EnumerateArray());
    }
}
