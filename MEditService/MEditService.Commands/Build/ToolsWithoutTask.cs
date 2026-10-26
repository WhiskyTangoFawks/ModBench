using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Each tool a manifest's steps run that this machine has no VS Code task for, named by the task's label with the
/// tool's page (mods.md, Build, story 14).</summary>
internal static class ToolsWithoutTask
{
    public static string? Why(Manifest manifest, IReadOnlySet<string> tasks)
    {
        var pages = manifest.Tools.DistinctBy(tool => tool.Task, StringComparer.Ordinal).ToDictionary(tool => tool.Task, tool => tool.Page, StringComparer.Ordinal);
        List<string> named =
        [
            .. manifest.Steps.Select(step => step.Task).Concat(pages.Keys).Distinct(StringComparer.Ordinal).Where(task => !tasks.Contains(task))
                .Select(task => pages.TryGetValue(task, out var page) ? $"'{task}' ({page})" : $"'{task}'"),
        ];
        return named switch
        {
            [] => null,
            [var one] => $"this machine has no task for its tool {one}",
            [.. var all, var last] => $"this machine has no task for its tools {string.Join(", ", all)} and {last}",
        };
    }
}
