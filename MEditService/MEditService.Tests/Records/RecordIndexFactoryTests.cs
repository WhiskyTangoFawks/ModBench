using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

public class RecordIndexFactoryTests
{
    [Fact]
    public void Create_ReturnsInitializedRepository()
    {
        var reflector = SharedSchemaReflector.Instance;
        IRecordIndexFactory factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));

        using var repo = factory.Create(GameRelease.Fallout4);

        var result = repo.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 1, Offset: 0));
        Assert.Equal(0, result.Total);
    }
}
