{{- define "cw.labels" -}}
app.kubernetes.io/part-of: cohortwatch
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "cw.selector" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{- define "cw.fullname" -}}
{{ .root.Release.Name }}-{{ .name }}
{{- end -}}
