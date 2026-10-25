using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderStatusApiTests : HostedTests
{
    [Fact]
    public async Task GetLoadOrderStatus_WithNoLoadOrder_Returns200AndStateNone()
    {
        var response = await Client.GetAsync(new Uri("/load-order/status", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var status = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("None", status.GetProperty("state").GetString());
        Assert.False(status.GetProperty("conflictsComputed").GetBoolean());
        Assert.Empty(status.GetProperty("indexedPlugins").EnumerateArray());
    }
}
