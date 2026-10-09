using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class MissingDocumentsApiTests : HostedTests
{
    private static readonly object Edit = new { plugin = "A.esp", origin = "AMod", op = "set", path = new[] { new { kind = "member", name = "HeightMax" } }, value = 1 };
    private static readonly object[] Records = [new { formKey = "000800:A.esp", plugin = "A.esp", origin = "AMod" }];
    private static readonly object[] Destinations = [new { name = "B.esp", origin = "BMod" }];

    public static TheoryData<string, object> RequestsWithoutDocuments => new()
    {
        { "/records/000800%3AA.esp/edit-changes", new { edit = Edit, text = "{}" } },
        { "/plugins/A.esp/create-record-changes", new { origin = "AMod", recordType = "npc_" } },
        { "/plugins/rename-source-changes", new { origin = "AMod", name = "A.esp", newName = "B.esp" } },
        { "/records/delete-changes", new { records = Records } },
        { "/records/copy-changes", new { records = Records, mode = "Override", destinations = Destinations } },
    };

    [Theory]
    [MemberData(nameof(RequestsWithoutDocuments))]
    public async Task AChangesRequestWithoutItsDocuments_Is400(string route, object body)
    {
        var response = await Client.PostAsJsonAsync(route, body);

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }
}
