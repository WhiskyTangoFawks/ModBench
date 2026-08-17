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
}
