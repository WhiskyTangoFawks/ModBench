using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

public class RecordRepositoryFactoryTests
{
    [Fact]
    public void Create_ReturnsInitializedRepository()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector), new FieldMetadataMapper());

        using var repo = factory.Create(GameRelease.Fallout4);

        // If Initialize was not called, GetRecords throws "table not found".
        // A zero-row result proves the repo is ready to use.
        var result = repo.GetRecords("npc_", null, null, 1, 0);
        Assert.Equal(0, result.Total);
    }
}
