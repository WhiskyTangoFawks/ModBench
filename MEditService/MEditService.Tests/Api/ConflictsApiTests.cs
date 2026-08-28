using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class ConflictsApiTests(LoadedApiFixture<ConflictPluginFixture> loaded) : IClassFixture<LoadedApiFixture<ConflictPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly ConflictPluginFixture _fixture = loaded.Plugin;

    [Fact]
    public async Task GetConflicts_ConflictingRecord_IsReturnedWithConflictAll()
    {
        var resp = await _client.GetAsync("/records/conflicts");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        var match = results.FirstOrDefault(r =>
            r.GetProperty("record").GetProperty("formKey").GetString() == _fixture.ConflictingNpcFormKey.ToString());
        Assert.NotEqual(default, match);
        // Two plugins, one uncontested field change → Override, not Conflict (a genuine
        // two-sided disagreement needs a third plugin — already covered at the service layer by
        // RecordQueryServiceTests.GetConflicts_ConflictingOverrides_IncludesRecordWithConflictState;
        // this test's own job is proving the wire shape, not re-proving the classification rule).
        Assert.Equal("Override", match.GetProperty("conflictAll").GetString());
    }

    [Fact]
    public async Task GetConflicts_UncontestedRecord_IsNotReturned()
    {
        var resp = await _client.GetAsync("/records/conflicts");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        Assert.DoesNotContain(results, r =>
            r.GetProperty("record").GetProperty("formKey").GetString() == _fixture.SolePluginNpcFormKey.ToString());
    }
}
