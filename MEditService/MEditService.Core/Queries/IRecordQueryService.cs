using MEditService.Core.Records;

namespace MEditService.Core.Queries;

public interface IRecordQueryService
{
    IReadOnlyList<PluginResponse> GetPlugins();
    IReadOnlyList<string> GetRecordTypes();
    PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset);
    RecordDetail? GetRecord(string formKey);
    RecordDetail? GetRecordForPlugin(string formKey, string plugin);
    string? GetRecordType(string formKey);
    CompareResult? GetCompare(string formKey);
    IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin);
    IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey);
    VmadData? GetVmad(string formKey, string plugin);
    PlacementRow? GetPlacement(string formKey, string plugin);
}
