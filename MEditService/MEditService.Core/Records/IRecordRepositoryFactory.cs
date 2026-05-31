using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public interface IRecordRepositoryFactory
{
    IRecordRepository Create(GameRelease gameRelease);
}
