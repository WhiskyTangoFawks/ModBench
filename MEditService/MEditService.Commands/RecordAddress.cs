using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>A record and the plugin holding it (ADR-0012), flat as the wire carries it.</summary>
public sealed record RecordAddress(string FormKey, string Plugin, string Origin)
{
    public static RecordAddress Of(RecordAt record) => new(record.FormKey, record.Plugin.Name, record.Plugin.Origin);

    public RecordAt ToRecordAt() => new(new PluginAddress(Plugin, Origin), FormKey);
}
